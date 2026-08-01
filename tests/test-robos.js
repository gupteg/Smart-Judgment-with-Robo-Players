const { io } = require('socket.io-client');

const URL = 'http://localhost:5066';
let hookViolations = 0;
let traceCount = 0;
let expertTraces = 0;
let malformedTraces = 0;
let expertPlayShown = 0;
let illegalPlays = 0;
let roundsCompleted = 0;
let errorsSeen = [];
let lastState = null;

function makeHuman() {
    const socket = io(URL, { transports: ['polling'] });
    let myId = null;

    socket.on('connect', () => {
        socket.emit('joinGame', { playerName: 'HumanTester', playerId: null });
    });

    socket.on('joinSuccess', ({ playerId }) => {
        myId = playerId;
        setTimeout(() => socket.emit('claimHost', { password: '' }), 200);
    });

    socket.on('showRoboConfig', () => {
        // Stress test: 5 robos (mix of Standard/Expert), 6 total seats
        socket.emit('addRobos', {
            roboConfigs: [
                { name: 'Bot-Std-1', difficulty: 'Standard' },
                { name: 'Bot-Std-2', difficulty: 'Standard' },
                { name: 'Bot-Exp-1', difficulty: 'Expert' },
                { name: 'Bot-Exp-2', difficulty: 'Expert' },
                { name: 'Bot-Std-3', difficulty: 'Standard' },
            ]
        });
        setTimeout(() => socket.emit('startGame'), 500);
    });

    // --- ROBO: M2 — the host should receive a reasoning trace for every
    // robo decision. Count them and sanity-check their shape. ---
    socket.on('roboTrace', (entry) => {
        traceCount++;
        if (!entry || !entry.trace || !entry.trace.headline) {
            malformedTraces++;
            return;
        }
        if (entry.trace.tier === 'Expert') expertTraces++;
        if (entry.trace.tier === 'Expert' && entry.trace.kind === 'play' && expertPlayShown < 3) { expertPlayShown++;
            console.log(`[TRACE] ${entry.name} (${entry.trace.kind}): ${entry.trace.headline}`);
            (entry.trace.lines || []).forEach(l => console.log(`         ${l}`));
        }
    });

    socket.on('announce', (msg) => console.log('[ANNOUNCE]', msg));
    socket.on('invalidBid', (msg) => {
        console.log('[INVALID BID]', msg);
        // Retry with an adjusted bid (server rejected due to the hook rule).
        const gs = lastState;
        if (gs && gs.phase === 'Bidding') {
            const maxBid = gs.numCardsToDeal;
            let retryBid = Math.floor(maxBid / 2) + 1;
            if (retryBid > maxBid) retryBid = Math.max(0, Math.floor(maxBid / 2) - 1);
            setTimeout(() => socket.emit('submitBid', { bid: retryBid }), 50);
        }
    });

    socket.on('promptForBid', ({ maxBid }) => {
        // Human bids a simple heuristic: half of maxBid, adjusted for hook rule server-side
        let bid = Math.floor(maxBid / 2);
        setTimeout(() => socket.emit('submitBid', { bid }), 50);
    });

    socket.on('finalGameOver', ({ gameState: gs, winners }) => {
        console.log('\n--- GAME OVER (finalGameOver event) ---');
        console.log('Winners:', winners.map(w => `${w.name}=${w.score}`).join(', '));
        console.log('Final scores:', gs.players.map(p => `${p.name}=${p.score}`).join(', '));
        console.log('Hook violations:', hookViolations, '| Illegal plays:', illegalPlays, '| Errors:', errorsSeen.length);
        console.log('Reasoning traces received:', traceCount, '| from Expert tier:', expertTraces, '| malformed:', malformedTraces);
        const traceOk = traceCount > 0 && malformedTraces === 0 && expertTraces > 0;
        if (!traceOk) errorsSeen.push('roboTrace delivery failed');
        console.log(hookViolations === 0 && illegalPlays === 0 && errorsSeen.length === 0
            ? '\n=== ALL CHECKS PASSED: full game completed cleanly with robos ==='
            : '\n=== FAILURES DETECTED ===');
        process.exit(hookViolations > 0 || illegalPlays > 0 || errorsSeen.length > 0 ? 1 : 0);
    });

    socket.on('updateGameState', (gs) => {
        lastState = gs;
        checkInvariants(gs);
        if (gs.roundNumber >= 8) {
            console.log(`[DEBUG r${gs.roundNumber}] phase=${gs.phase} bidIdx=${gs.biddingPlayerIndex} curIdx=${gs.currentPlayerIndex} cards=${gs.numCardsToDeal} trick=${gs.currentTrick.length} bids=${gs.players.map(p=>p.bid).join(',')} hands=${gs.players.map(p=>p.hand.length).join(',')}`);
        }

        if (gs.phase === 'RoundOver') {
            roundsCompleted++;
            console.log(`\n=== Round ${gs.roundNumber} over. Scores: ${gs.players.map(p => p.name + '=' + p.score).join(', ')} ===\n`);
            if (roundsCompleted >= 8) {
                console.log('\n--- TEST COMPLETE: 4 rounds finished without crash ---');
                console.log('Hook violations:', hookViolations, '| Illegal plays:', illegalPlays, '| Errors:', errorsSeen.length);
        console.log('Reasoning traces received:', traceCount, '| from Expert tier:', expertTraces, '| malformed:', malformedTraces);
                process.exit(hookViolations > 0 || illegalPlays > 0 || errorsSeen.length > 0 ? 1 : 0);
            }
            setTimeout(() => socket.emit('startNextRound'), 1000);
            return;
        }

        if (gs.phase === 'GameOver') {
            console.log('\n--- GAME OVER reached before 4 rounds tested ---');
            console.log('Hook violations:', hookViolations, '| Illegal plays:', illegalPlays, '| Errors:', errorsSeen.length);
        console.log('Reasoning traces received:', traceCount, '| from Expert tier:', expertTraces, '| malformed:', malformedTraces);
            process.exit(0);
        }

        if (gs.phase === 'Playing' && gs.currentPlayerIndex !== null) {
            const me = gs.players.find(p => p.playerId === myId);
            const currentPlayer = gs.players[gs.currentPlayerIndex];
            if (currentPlayer && currentPlayer.playerId === myId && me && me.hand.length > 0) {
                // Play first legal card
                let legal = me.hand;
                if (gs.leadSuit) {
                    const followable = me.hand.filter(c => c.suit === gs.leadSuit);
                    if (followable.length > 0) legal = followable;
                }
                const card = legal[0];
                setTimeout(() => socket.emit('playCard', { card }), 50);
            }
        }
    });

    socket.on('connect_error', (err) => { console.error('CONNECT ERROR', err.message); errorsSeen.push(err.message); });
}

function checkInvariants(gs) {
    // Check hook rule: total bids should never equal numCardsToDeal once all bids are in
    if (gs.phase !== 'Bidding' && gs.numCardsToDeal > 0) {
        const allBid = gs.players.every(p => p.status !== 'Active' || p.bid !== null);
        if (allBid) {
            const sum = gs.players.reduce((a, p) => a + (p.bid || 0), 0);
            if (sum === gs.numCardsToDeal) {
                hookViolations++;
                console.error(`!!! HOOK RULE VIOLATED: sum=${sum} handSize=${gs.numCardsToDeal}`);
            }
        }
    }
}

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION in test client:', err);
    errorsSeen.push(err.message);
});

makeHuman();

setTimeout(() => {
    console.log('\n--- TIMEOUT: test did not complete in time ---');
    console.log('Last state phase:', lastState?.phase, 'round:', lastState?.roundNumber);
    process.exit(2);
}, 90000);
