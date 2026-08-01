const http = require('http');
const express = require('express');
const path = require('path');
const { Server } = require("socket.io");

// --- ROBO: Robo Player modules ---
const { RoboPlayer } = require('./server-src/player');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

let players = [];
let gameState = null;
const reconnectTimers = {};
const DISCONNECT_GRACE_PERIOD = 60000;
let gameOverCleanupTimer = null;
// --- *** NEW: Host Password variable (moved from startGame) *** ---
const HOST_PASSWORD = process.env.HOST_PASSWORD || null;

const SUITS = ['Spades', 'Hearts', 'Diamonds', 'Clubs'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUES = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };

// --- ROBO: AI runtime state & tuning ---
// ROBO_FAST_TEST shrinks think-time delays for automated integration
// testing only; production always uses the full tiered delays below.
const ROBO_FAST_TEST        = process.env.ROBO_FAST_TEST === '1';
const ROBO_BID_TIME         = ROBO_FAST_TEST ? 30 : 6000;  // ms — bidding decision
const ROBO_PLAY_TIME        = ROBO_FAST_TEST ? 20 : 3000;  // ms — card play with a genuine choice among legal cards
const ROBO_FORCED_PLAY_TIME = ROBO_FAST_TEST ? 10 : 1000;  // ms — only one legal card, no real choice
const ROBO_TIMEOUT          = 15000; // ms — safety net; strategy must resolve within this or we fall back
const MAX_TOTAL_SEATS       = 8;     // host + humans + robos, combined
const VALID_DIFFICULTIES    = ['Standard', 'Expert'];

// --- ROBO: diagnostics -------------------------------------------------
// I1 — telemetry. One console line per robo per round recording bid vs
// tricks actually won, so bid bias can be MEASURED between games instead of
// inferred from a few hands. Console only: Render's filesystem is ephemeral
// and would silently discard a log file on every restart or deploy.
// Off by default; enable with ROBO_TELEMETRY=1.
const ROBO_TELEMETRY = process.env.ROBO_TELEMETRY === '1' || ROBO_FAST_TEST;
// M2 — reasoning trace. Streams each robo's decision rationale to the HOST
// only. Also gated, since it is a debugging aid rather than a game feature.
const ROBO_TRACE     = process.env.ROBO_TRACE !== '0';

let roboInstances   = new Map(); // Map<playerId, RoboPlayer> — never serialised to client
let roboTurnPending  = false;    // Prevents double-scheduling
const TRICK_REVIEW_MS = ROBO_FAST_TEST ? 50 : 10000;
const END_OF_ROUND_MS = ROBO_FAST_TEST ? 50 : 3000;

// ADDED: Centralized function to add logs to gameState
function addLog(message) {
    if (!gameState) return;
    gameState.logHistory.push(message);
    io.emit('gameLog', message); // Still emit for real-time notification, but client will rely on gameState
}

function startNextTrick() {
    if (!gameState || gameState.isPaused || gameState.phase !== 'TrickReview') return;

    let winnerIndex = gameState.players.findIndex(p => p.playerId === gameState.trickWinnerId);
    gameState.phase = 'Playing';
    gameState.currentTrick = [];
    gameState.leadSuit = null;
    gameState.trickWinnerId = null;
    gameState.nextTrickReviewEnd = null;
    gameState.currentWinningPlayerId = null;

    if (winnerIndex === -1 || gameState.players[winnerIndex].status !== 'Active') {
        gameState.currentPlayerIndex = findNextActivePlayer(winnerIndex, gameState.players, false);
    } else {
        gameState.currentPlayerIndex = winnerIndex;
    }
    io.emit('updateGameState', gameState);
    scheduleRoboTurnIfNeeded(); // --- ROBO: the new trick's leader may be a robo ---
}

function findNextActivePlayer(startIndex, players, startFromNext = true) {
    const numPlayers = players.length;
    if (numPlayers === 0 || players.every(p => p.status !== 'Active')) return null;
    let nextIndex = startFromNext ? (startIndex + 1) % numPlayers : startIndex;
    let checkedCount = 0;
    while (players[nextIndex].status !== 'Active' && checkedCount < numPlayers) {
        nextIndex = (nextIndex + 1) % numPlayers;
        checkedCount++;
    }
    return players[nextIndex].status === 'Active' ? nextIndex : null;
}

function createDeck() { return SUITS.flatMap(suit => RANKS.map(rank => ({ suit, rank, value: RANK_VALUES[rank] }))); }
function shuffleDeck(deck) { for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[deck[i], deck[j]] = [deck[j], deck[i]]; } return deck; }

function setupGame(lobbyPlayers) {
    const numPlayers = lobbyPlayers.length;
    const maxCards = Math.floor(52 / numPlayers);
    // --- *** MODIFIED: playOrder is now based on the lobby order (Host is index 0) *** ---
    const gamePlayers = lobbyPlayers.map((p, i) => ({
        playerId: p.playerId, socketId: p.socketId, name: p.name, isHost: p.isHost,
        score: 0, hand: [], bid: null, tricksWon: 0, scoreHistory: [], playOrder: i,
        status: 'Active',
        // --- ROBO: flags (false/null for human players) ---
        isRobo: p.isRobo || false,
        difficulty: p.difficulty || null,
    }));
    // --- *** END MODIFICATION *** ---
    return {
        players: gamePlayers, roundNumber: 0, maxRounds: maxCards, dealerIndex: -1, numCardsToDeal: 0,
        trumpSuit: null, leadSuit: null, currentTrick: [], currentWinningPlayerId: null, trickWinnerId: null,
        lastCompletedTrick: null, logHistory: [], // MODIFIED: Added log history to gameState
        isPaused: false, pausedForPlayerNames: [], pauseEndTime: null,
        phase: 'Bidding', nextRoundInfo: null, nextTrickReviewEnd: null,
        isEnding: false, // MODIFIED: Added flag to prevent pausing during game end
    };
}

function startNewRound() {
    gameState.roundNumber++;
    gameState.numCardsToDeal = gameState.maxRounds - (gameState.roundNumber - 1);
    if (gameState.numCardsToDeal < 1) { return handleGameOver(); }
    gameState.dealerIndex = findNextActivePlayer(gameState.dealerIndex, gameState.players);
    const trumpCycle = ['Spades', 'Hearts', 'Diamonds', 'Clubs', 'No Trump'];
    gameState.trumpSuit = trumpCycle[(gameState.roundNumber - 1) % 5];
    let deck = shuffleDeck(createDeck());
    gameState.players.forEach(p => {
        if (p.status === 'Active') { p.hand = deck.splice(0, gameState.numCardsToDeal); }
        p.bid = null; p.tricksWon = 0;
    });
    const biddingPlayerIndex = findNextActivePlayer(gameState.dealerIndex, gameState.players);
    Object.assign(gameState, {
        currentTrick: [], leadSuit: null, currentWinningPlayerId: null, trickWinnerId: null,
        lastCompletedTrick: null,
        phase: 'Bidding', nextRoundInfo: null, biddingPlayerIndex: biddingPlayerIndex,
        currentPlayerIndex: null,
    });
    // --- ROBO: fresh memory AND fresh round context every round (new hand,
    // new trump, new bid ledger). Seeded with this round's deal facts. ---
    const roboDeal = {
        handSize: gameState.numCardsToDeal,
        trumpSuit: gameState.trumpSuit,
        playerOrder: gameState.players.filter(p => p.status === 'Active').map(p => p.playerId),
        dealerId: gameState.players[gameState.dealerIndex]?.playerId || null,
    };
    roboInstances.forEach(robo => robo.resetRound(roboDeal));
    addLog(`Round ${gameState.roundNumber} begins. Cards: ${gameState.numCardsToDeal}. Trump: ${gameState.trumpSuit}.`);
    io.emit('updateGameState', gameState);
    const firstBidder = gameState.players[biddingPlayerIndex];
    if (firstBidder && !firstBidder.isRobo) {
        io.to(firstBidder.socketId).emit('promptForBid', { maxBid: gameState.numCardsToDeal });
    }
    scheduleRoboTurnIfNeeded(); // --- ROBO: in case the first bidder is a robo ---
}

function handleEndOfRound() {
    logRoboTelemetry(); // --- ROBO: I1, before scores mutate anything ---
    gameState.players.forEach(p => {
        if (p.status !== 'Active') { p.scoreHistory.push(null); return; }
        let roundScore = (p.tricksWon === p.bid) ? (10 + p.bid) : (p.bid * -1);
        p.score += roundScore;
        p.scoreHistory.push(roundScore);
    });
    if (gameState.numCardsToDeal <= 1) { return handleGameOver(); }
    gameState.phase = 'RoundOver';
    const nextRoundNumber = gameState.roundNumber + 1;
    const nextNumCards = gameState.maxRounds - (nextRoundNumber - 1);
    const trumpCycle = ['Spades', 'Hearts', 'Diamonds', 'Clubs', 'No Trump'];
    const nextDealerIndex = findNextActivePlayer(gameState.dealerIndex, gameState.players);
    const nextDealer = gameState.players[nextDealerIndex];
    gameState.nextRoundInfo = {
        nextNumCards: nextNumCards,
        nextTrumpSuit: (nextNumCards > 0) ? trumpCycle[(nextRoundNumber - 1) % 5] : 'None',
        nextDealerName: nextDealer ? nextDealer.name : 'N/A'
    };
    addLog(`🏁 Round ${gameState.roundNumber} has ended. Scores calculated.`);
    io.emit('updateGameState', gameState);
}

function handleGameOver() {
    if (gameState && gameState.phase !== 'GameOver') {
        gameState.phase = 'GameOver';
        gameState.isEnding = true; // MODIFIED: Flag the game as ending
        Object.values(reconnectTimers).forEach(clearTimeout);
        const eligiblePlayers = gameState.players.filter(p => p.status !== 'Removed');
        const highestScore = Math.max(-Infinity, ...eligiblePlayers.map(p => p.score));
        const winners = eligiblePlayers.filter(p => p.score === highestScore).map(p => ({ name: p.name, score: p.score }));
        addLog(`GAME OVER!`);
        io.emit('finalGameOver', { gameState, winners });

        if (gameOverCleanupTimer) clearTimeout(gameOverCleanupTimer);
        gameOverCleanupTimer = setTimeout(() => {
            if (gameState) {
                const finalPlayers = gameState.players.filter(p => p.status !== 'Removed');
                players = finalPlayers
                    .filter(p => !p.isRobo) // --- ROBO: exclude robos from the lobby list ---
                    .map(p => ({
                        playerId: p.playerId, socketId: p.socketId, name: p.name,
                        isHost: p.isHost, active: true, isReady: p.isHost
                    }));
                roboInstances.clear(); // --- ROBO ---
                // --- *** MODIFIED: Ensure host is ready after game over *** ---
                const host = players.find(p => p.isHost);
                if (host) {
                    host.isReady = true;
                } else if (players.length > 0) {
                    // If host was removed, assign a new one
                    players[0].isHost = true;
                    players[0].isReady = true;
                }
                // --- *** END MODIFICATION *** ---
                gameState = null;
                io.emit('lobbyUpdate', players);
            }
        }, 20000);
    }
}

function updateCurrentWinner(gs) {
    if (gs.currentTrick.length === 0) { gs.currentWinningPlayerId = null; return; }
    const trick = gs.currentTrick; const trump = gs.trumpSuit; let winner = trick[0];
    for (let i = 1; i < trick.length; i++) {
        const currentPlay = trick[i];
        if (winner.card.suit === trump && currentPlay.card.suit !== trump) continue;
        if (winner.card.suit !== trump && currentPlay.card.suit === trump) winner = currentPlay;
        else if (currentPlay.card.suit === winner.card.suit && currentPlay.card.value > winner.card.value) winner = currentPlay;
    }
    gs.currentWinningPlayerId = winner.playerId;
}

function evaluateTrick() {
    gameState.lastCompletedTrick = {
        trick: [...gameState.currentTrick],
        winnerId: gameState.currentWinningPlayerId,
    };

    const winnerData = gameState.players.find(p => p.playerId === gameState.currentWinningPlayerId);
    if (winnerData) {
        winnerData.tricksWon++;
        // --- ROBO: robos see the cards played, but were never told who WON.
        // The trick ledger drives the running gap-to-target audit (R18). ---
        recordTrickWinnerForRoboMemories(winnerData.playerId);
        io.emit('trickWon', { winnerName: winnerData.name });
        // MODIFIED: Server now logs the trick winner.
        addLog(`🏆 ${winnerData.name} wins the trick!`);
    }

    const allHandsEmpty = gameState.players.filter(p => p.status === 'Active').every(p => p.hand.length === 0);
    if (allHandsEmpty) {
        io.emit('updateGameState', gameState);
        setTimeout(handleEndOfRound, END_OF_ROUND_MS);
        return;
    }

    gameState.phase = 'TrickReview';
    gameState.trickWinnerId = winnerData?.playerId;
    gameState.nextTrickReviewEnd = Date.now() + TRICK_REVIEW_MS;
    io.emit('updateGameState', gameState);
    setTimeout(startNextTrick, TRICK_REVIEW_MS);
}

// ─────────────────────────────────────────────────────────────────────────
// ROBO: shared bid/play application logic
// Extracted from the socket handlers so both human (socket) and robo
// (server-driven) turns go through the exact same validated path — a robo
// can never produce a move the server itself considers illegal.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Apply a bid for the player currently up to bid. Mirrors the validation
 * and state transitions previously inline in socket.on('submitBid').
 * @param {number} playerIndex
 * @param {number} proposedBid
 * @returns {{ok:boolean, message?:string}}
 */
function applyBid(playerIndex, proposedBid) {
    if (!gameState || gameState.phase !== 'Bidding' || gameState.isPaused) return { ok: false };
    const player = gameState.players[playerIndex];
    if (!player || playerIndex !== gameState.biddingPlayerIndex) return { ok: false };
    if (isNaN(proposedBid)) return { ok: false };

    const isLastBidder = findNextActivePlayer(gameState.biddingPlayerIndex, gameState.players) === findNextActivePlayer(gameState.dealerIndex, gameState.players);
    if (isLastBidder) {
        const bidsSoFar = gameState.players.reduce((acc, p) => acc + (p.bid || 0), 0);
        if ((bidsSoFar + proposedBid) === gameState.numCardsToDeal) {
            return { ok: false, message: `Total bid cannot be ${gameState.numCardsToDeal}. Please bid again.` };
        }
    }
    player.bid = proposedBid;
    addLog(`📣 ${player.name} bids ${player.bid}.`);
    // --- ROBO: every robo sees every bid, in ORDER. Bidding order matters:
    // a robo bidding last weights the residual-tricks signal far more
    // heavily than one bidding first (B11). ---
    recordBidForRoboMemories(player.playerId, proposedBid);

    const nextBidderIndex = findNextActivePlayer(gameState.biddingPlayerIndex, gameState.players);
    if (nextBidderIndex === findNextActivePlayer(gameState.dealerIndex, gameState.players)) {
        gameState.phase = 'Playing';
        gameState.biddingPlayerIndex = null;
        gameState.currentPlayerIndex = findNextActivePlayer(gameState.dealerIndex, gameState.players);
        // --- ROBO: the table's over/under regime (T1) is now locked in. ---
        roboInstances.forEach(robo => robo.markBiddingComplete());
        announceTableRegime();
        addLog(`Bidding complete. ${gameState.players[gameState.currentPlayerIndex]?.name} starts.`);
    } else {
        gameState.biddingPlayerIndex = nextBidderIndex;
        const nextBidder = gameState.players[nextBidderIndex];
        if (nextBidder && !nextBidder.isRobo) {
            io.to(nextBidder.socketId).emit('promptForBid', { maxBid: gameState.numCardsToDeal });
        }
    }
    return { ok: true };
}

/**
 * Apply a card play for the player currently up to act. Mirrors the
 * validation and state transitions previously inline in socket.on('playCard').
 * @param {number} playerIndex
 * @param {{suit:string, rank:string}} card
 * @returns {{ok:boolean, message?:string}}
 */
function applyCardPlay(playerIndex, card) {
    if (!gameState || gameState.phase !== 'Playing' || gameState.isPaused) return { ok: false };
    const player = gameState.players[playerIndex];
    if (!player || playerIndex !== gameState.currentPlayerIndex) return { ok: false };
    const cardInHandIndex = player.hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);
    if (cardInHandIndex === -1) return { ok: false };

    if (gameState.leadSuit) {
        if (player.hand.some(c => c.suit === gameState.leadSuit) && card.suit !== gameState.leadSuit) {
            return { ok: false, message: `You must play a ${gameState.leadSuit} card.` };
        }
        // --- ROBO: a legal off-suit play while a suit was led is a revealed void ---
        if (card.suit !== gameState.leadSuit) {
            recordVoidForRoboMemories(player.playerId, gameState.leadSuit);
        }
    } else {
        gameState.leadSuit = card.suit;
    }

    player.hand.splice(cardInHandIndex, 1);
    gameState.currentTrick.push({ playerId: player.playerId, name: player.name, card });
    recordCardForRoboMemories(card, player.playerId);
    updateCurrentWinner(gameState);
    addLog(`› ${player.name} played the ${card.rank} of ${card.suit}.`);

    const activePlayersCount = gameState.players.filter(p => p.status === 'Active').length;
    if (gameState.currentTrick.length < activePlayersCount) {
        gameState.currentPlayerIndex = findNextActivePlayer(gameState.currentPlayerIndex, gameState.players);
        return { ok: true, trickCompleted: false };
    }
    evaluateTrick(); // handles its own updateGameState emit + next-step timers
    return { ok: true, trickCompleted: true };
}

// ─────────────────────────────────────────────────────────────────────────
// ROBO: memory helpers
// ─────────────────────────────────────────────────────────────────────────

function recordCardForRoboMemories(card, playerId) {
    roboInstances.forEach(robo => robo.recordCard(card, playerId));
}

function recordVoidForRoboMemories(playerId, suit) {
    roboInstances.forEach(robo => robo.recordVoid(playerId, suit));
}

function recordBidForRoboMemories(playerId, bid) {
    roboInstances.forEach(robo => robo.recordBid(playerId, bid));
}

function recordTrickWinnerForRoboMemories(playerId) {
    roboInstances.forEach(robo => robo.recordTrickWinner(playerId));
}

/**
 * T1 — log the table's structural position once bidding closes. The hook
 * rule guarantees total bids never equal the hand size, so every round is
 * either UNDERBID (spare tricks nobody claimed — somebody must eat them) or
 * OVERBID (tricks are scarcer than claimed — somebody gets starved).
 */
function announceTableRegime() {
    const total = gameState.players.reduce((s, p) => s + (p.bid || 0), 0);
    const surplus = gameState.numCardsToDeal - total;
    if (surplus > 0) {
        addLog(`Total bids ${total} of ${gameState.numCardsToDeal} — ${surplus} spare trick${surplus === 1 ? '' : 's'} in play.`);
    } else {
        addLog(`Total bids ${total} of ${gameState.numCardsToDeal} — the table is over-bid by ${-surplus}.`);
    }
}

/**
 * M2 — forward a robo's reasoning to the HOST only. Never broadcast: it
 * would reveal hand information to the whole table.
 */
function emitRoboTrace(roboPlayer, roboInstance) {
    if (!ROBO_TRACE || !gameState) return;
    const trace = roboInstance.lastTrace;
    if (!trace) return;
    const host = gameState.players.find(p => p.isHost && !p.isRobo && p.socketId);
    if (!host) return;
    io.to(host.socketId).emit('roboTrace', {
        playerId: roboPlayer.playerId,
        name: roboPlayer.name,
        difficulty: roboPlayer.difficulty,
        round: gameState.roundNumber,
        trick: (gameState.numCardsToDeal - (roboPlayer.hand ? roboPlayer.hand.length : 0)),
        trace,
        at: Date.now(),
    });
}

/**
 * I1 — one console line per robo per round. Deliberately terse and greppable
 * so a play session can be scanned for bid bias at a glance.
 */
function logRoboTelemetry() {
    if (!ROBO_TELEMETRY || !gameState) return;
    gameState.players.forEach(p => {
        if (!p.isRobo) return;
        const hit = p.tricksWon === p.bid;
        const delta = p.tricksWon - p.bid;
        const score = hit ? (10 + p.bid) : -p.bid;
        console.log(
            `[RoboStat] round=${gameState.roundNumber} cards=${gameState.numCardsToDeal} ` +
            `trump=${gameState.trumpSuit} tier=${p.difficulty} name=${p.name} ` +
            `bid=${p.bid} won=${p.tricksWon} delta=${delta >= 0 ? '+' : ''}${delta} ` +
            `result=${hit ? 'HIT' : (delta > 0 ? 'OVERSHOT' : 'SHORT')} score=${score}`
        );
    });
}

// ─────────────────────────────────────────────────────────────────────────
// ROBO: turn scheduling
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build the context object a robo's bid decision needs beyond raw gameState.
 * @param {number} playerIndex
 * @returns {{isLastBidder:boolean}}
 */
function buildBidContext(playerIndex) {
    const isLastBidder = findNextActivePlayer(playerIndex, gameState.players) === findNextActivePlayer(gameState.dealerIndex, gameState.players);
    return { isLastBidder };
}

/**
 * Build the context object a robo's card-play decision needs beyond raw gameState.
 * @returns {{tricksPlayedSoFar:number, tricksRemaining:number}}
 */
function buildPlayContext() {
    const activePlayers = gameState.players.filter(p => p.status === 'Active');
    // Any active player's hand length (before their own play) reflects
    // tricks already completed this round, since everyone is dealt the
    // same number of cards and loses one card per completed trick.
    const sample = activePlayers.find(p => p.hand.length >= 0);
    const tricksPlayedSoFar = sample ? (gameState.numCardsToDeal - sample.hand.length) : 0;
    const tricksRemaining = gameState.numCardsToDeal - tricksPlayedSoFar;
    // --- ROBO: R10 — seat position within the trick. A "winning" card that
    // three players still get to beat is not a winner; without this the robo
    // plays its cheapest winner first-to-act and loses the trick anyway. ---
    const playersYetToAct = Math.max(0, activePlayers.length - gameState.currentTrick.length - 1);
    return { tricksPlayedSoFar, tricksRemaining, playersYetToAct };
}

/**
 * Return the appropriate delay before the next robo action, based on the
 * decision type currently pending.
 */
function getRoboDelay() {
    if (!gameState) return ROBO_PLAY_TIME;
    if (gameState.phase === 'Bidding') return ROBO_BID_TIME;
    if (gameState.phase === 'Playing') {
        const player = gameState.players[gameState.currentPlayerIndex];
        if (!player) return ROBO_PLAY_TIME;
        const legalCount = gameState.leadSuit
            ? (player.hand.some(c => c.suit === gameState.leadSuit)
                ? player.hand.filter(c => c.suit === gameState.leadSuit).length
                : player.hand.length)
            : player.hand.length;
        return legalCount <= 1 ? ROBO_FORCED_PLAY_TIME : ROBO_PLAY_TIME;
    }
    return ROBO_PLAY_TIME;
}

/**
 * Schedule a robo turn if the player who must act next is a robo.
 * Idempotent — roboTurnPending flag prevents double-scheduling.
 */
function scheduleRoboTurnIfNeeded() {
    if (!gameState || gameState.isPaused || roboTurnPending) return;

    let actor = null;
    if (gameState.phase === 'Bidding' && gameState.biddingPlayerIndex !== null && gameState.biddingPlayerIndex !== undefined) {
        actor = gameState.players[gameState.biddingPlayerIndex];
    } else if (gameState.phase === 'Playing' && gameState.currentPlayerIndex !== null && gameState.currentPlayerIndex !== undefined) {
        actor = gameState.players[gameState.currentPlayerIndex];
    }
    if (!actor || !actor.isRobo || actor.status !== 'Active') return;
    // --- ROBO: defensive guard — never schedule a play turn for a player
    // whose hand is already empty (can happen because evaluateTrick() does
    // not change gameState.phase away from 'Playing' when the round itself
    // just ended on the final trick; trickCompleted-based branching in
    // processRoboTurn is the primary fix, this is a belt-and-braces check). ---
    if (gameState.phase === 'Playing' && (!actor.hand || actor.hand.length === 0)) return;

    const delay = getRoboDelay();
    roboTurnPending = true;
    setTimeout(() => {
        roboTurnPending = false;
        if (gameState && !gameState.isPaused) {
            processRoboTurn().catch(err => console.error('[Robo] Unhandled error in processRoboTurn:', err));
        }
    }, delay);
}

/**
 * Main robo turn processor. Determines which robo must act, asks its
 * strategy for a decision, applies it via the shared applyBid/applyCardPlay
 * path, then schedules the next robo turn if needed.
 */
async function processRoboTurn() {
    if (!gameState) return;

    if (gameState.phase === 'Bidding') {
        const roboIndex = gameState.biddingPlayerIndex;
        const roboPlayer = gameState.players[roboIndex];
        if (!roboPlayer?.isRobo || roboPlayer.status !== 'Active') return;
        const roboInstance = roboInstances.get(roboPlayer.playerId);
        if (!roboInstance) { console.error(`[Robo] No instance found for ${roboPlayer.name}`); return; }

        try {
            const context = buildBidContext(roboIndex);
            const bidPromise = roboInstance.makeBid(gameState, roboIndex, context);
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Robo timeout')), ROBO_TIMEOUT));
            const bid = await Promise.race([bidPromise, timeoutPromise]);
            emitRoboTrace(roboPlayer, roboInstance); // --- ROBO: M2 ---
            applyBid(roboIndex, bid);
        } catch (err) {
            console.error(`[Robo] Error during ${roboPlayer.name}'s bid, falling back to 0:`, err.message);
            applyBid(roboIndex, 0);
        }
        io.emit('updateGameState', gameState);
        scheduleRoboTurnIfNeeded();
        return;
    }

    if (gameState.phase === 'Playing') {
        const roboIndex = gameState.currentPlayerIndex;
        const roboPlayer = gameState.players[roboIndex];
        if (!roboPlayer?.isRobo || roboPlayer.status !== 'Active') return;
        const roboInstance = roboInstances.get(roboPlayer.playerId);
        if (!roboInstance) { console.error(`[Robo] No instance found for ${roboPlayer.name}`); return; }

        try {
            const context = buildPlayContext();
            const movePromise = roboInstance.makeMove(gameState, roboIndex, context);
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Robo timeout')), ROBO_TIMEOUT));
            const card = await Promise.race([movePromise, timeoutPromise]);
            emitRoboTrace(roboPlayer, roboInstance); // --- ROBO: M2 ---
            const result = applyCardPlay(roboIndex, card);
            if (!result.ok) {
                // Strategy returned something the server considers illegal —
                // fall back to a safe random legal card rather than stalling.
                const fallback = randomLegalCardFor(roboPlayer);
                if (fallback) applyCardPlay(roboIndex, fallback);
            } else if (!result.trickCompleted) {
                // Only emit/schedule here when play continues within the same
                // trick — if the trick completed, evaluateTrick() already
                // emitted state and owns scheduling the next step (note: it
                // does NOT change gameState.phase away from 'Playing' when
                // the round itself just ended, so we must not treat phase
                // alone as a signal here — trickCompleted is authoritative).
                io.emit('updateGameState', gameState);
                scheduleRoboTurnIfNeeded();
            }
        } catch (err) {
            console.error(`[Robo] Error during ${roboPlayer.name}'s play, falling back to random legal card:`, err.stack || err.message);
            const fallback = randomLegalCardFor(roboPlayer);
            if (fallback) applyCardPlay(roboIndex, fallback);
        }
        return;
    }
}

/** Fallback: pick a random legal card for a robo whose strategy failed or timed out. */
function randomLegalCardFor(player) {
    let candidates = player.hand;
    if (gameState.leadSuit) {
        const followable = player.hand.filter(c => c.suit === gameState.leadSuit);
        if (followable.length > 0) candidates = followable;
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
}

function handlePlayerRemoval(playerId) {
    if (!gameState) return;
    const player = gameState.players.find(p => p.playerId === playerId);
    if (!player || player.status !== 'Disconnected') return;
    // --- ROBO: robos never enter Disconnected status; defensive guard ---
    if (player.isRobo) return;
    player.status = 'Removed';
    addLog(`Player ${player.name} failed to reconnect and has been removed.`);
    delete reconnectTimers[playerId];
    if (player.isHost) {
        const nextHost = gameState.players.find(p => p.status === 'Active');
        if (nextHost) {
            nextHost.isHost = true;
            addLog(`Host privileges transferred to ${nextHost.name}.`);
        }
    }
    const activePlayers = gameState.players.filter(p => p.status === 'Active');
    const activeHumans = activePlayers.filter(p => !p.isRobo);
    if (activePlayers.length < 2 || activeHumans.length === 0) {
        addLog('Not enough players to continue. Returning to lobby.');
        const finalPlayers = gameState.players.filter(p => p.status !== 'Removed');
        players = finalPlayers
            .filter(p => !p.isRobo) // --- ROBO: exclude robos from the lobby list ---
            .map(p => ({
                playerId: p.playerId, socketId: p.socketId, name: p.name,
                isHost: p.isHost, active: true, isReady: p.isHost
            }));
        roboInstances.clear(); // --- ROBO ---
        // --- *** MODIFIED: Ensure host logic on game collapse *** ---
        const host = players.find(p => p.isHost);
        if (host) {
            host.isReady = true;
        } else if (players.length > 0) {
            players[0].isHost = true;
            players[0].isReady = true;
        }
        // --- *** END MODIFICATION *** ---
        gameState = null;
        io.emit('lobbyUpdate', players);
        return;
    }
    const stillDisconnected = gameState.players.some(p => p.status === 'Disconnected');
    if (!stillDisconnected) {
        gameState.isPaused = false;
        gameState.pausedForPlayerNames = [];
        gameState.pauseEndTime = null;
    } else {
        gameState.pausedForPlayerNames = gameState.players.filter(p => p.status === 'Disconnected').map(p => p.name);
    }
    const biddingPlayer = gameState.players[gameState.biddingPlayerIndex];
    if (gameState.phase === 'Bidding' && biddingPlayer?.playerId === playerId) {
        const nextBidderIndex = findNextActivePlayer(gameState.biddingPlayerIndex, gameState.players);
        gameState.biddingPlayerIndex = nextBidderIndex;
        const nextBidder = gameState.players[nextBidderIndex];
        if (nextBidder && !nextBidder.isRobo) io.to(nextBidder.socketId).emit('promptForBid', { maxBid: gameState.numCardsToDeal });
    } else if (gameState.phase === 'Playing' && gameState.players[gameState.currentPlayerIndex]?.playerId === playerId) {
        gameState.currentPlayerIndex = findNextActivePlayer(gameState.currentPlayerIndex, gameState.players);
    }
    io.emit('updateGameState', gameState);
    scheduleRoboTurnIfNeeded(); // --- ROBO: removal may have shifted the turn to a robo ---
}

io.on('connection', (socket) => {
    // --- *** MODIFIED: joinGame Handler *** ---
    socket.on('joinGame', ({ playerName, playerId }) => {
        if (gameState) {
            // Reconnection Logic
            const disconnectedPlayers = gameState.players.filter(p => p.status === 'Disconnected');
            let playerToRejoin = null;
            if (playerId) playerToRejoin = disconnectedPlayers.find(p => p.playerId === playerId);
            if (!playerToRejoin && disconnectedPlayers.length > 0) {
                playerToRejoin = disconnectedPlayers.find(p => p.name.toLowerCase() === playerName.toLowerCase());
            }
            if (playerToRejoin) {
                playerToRejoin.status = 'Active';
                playerToRejoin.socketId = socket.id;
                clearTimeout(reconnectTimers[playerToRejoin.playerId]);
                delete reconnectTimers[playerToRejoin.playerId];
                const stillDisconnected = gameState.players.filter(p => p.status === 'Disconnected');
                if (stillDisconnected.length === 0) {
                    gameState.isPaused = false;
                    gameState.pauseEndTime = null;
                    gameState.pausedForPlayerNames = [];
                } else {
                    gameState.pausedForPlayerNames = stillDisconnected.map(p => p.name);
                }
                const playerIndex = gameState.players.findIndex(p => p.playerId === playerToRejoin.playerId);
                if (gameState.phase === 'Bidding' && gameState.biddingPlayerIndex === playerIndex) {
                    io.to(playerToRejoin.socketId).emit('promptForBid', { maxBid: gameState.numCardsToDeal });
                }
                socket.emit('joinSuccess', { playerId: playerToRejoin.playerId, lobby: players });
                addLog(`Player ${playerToRejoin.name} has reconnected.`);
                io.emit('updateGameState', gameState);
                return;
            }
            return socket.emit('announce', 'Game is already in progress.');
        }

        // Lobby Logic
        let pId = playerId || Math.random().toString(36).substr(2, 9);
        const existingPlayer = players.find(p => p.playerId === pId);
        if (!existingPlayer) {
            // const isHost = players.length === 0; // --- REMOVED ---
            players.push({ 
                playerId: pId, 
                socketId: socket.id, 
                name: playerName, 
                isHost: false, // --- MODIFIED ---
                active: true, 
                isReady: false // --- MODIFIED ---
            });
        } else {
            existingPlayer.socketId = socket.id;
            existingPlayer.name = playerName;
            existingPlayer.active = true;
            // Note: existingPlayer.isHost and isReady are preserved
        }
        socket.emit('joinSuccess', { playerId: pId, lobby: players });
        io.emit('lobbyUpdate', players);
    });
    // --- *** END MODIFIED joinGame *** ---

    // --- *** NEW: claimHost Handler *** ---
    socket.on('claimHost', ({ password }) => {
        // 1. Check if a host already exists
        if (players.some(p => p.isHost)) {
            return socket.emit('announce', 'A host has already been claimed.');
        }

        // 2. Refined Password Check (uses global HOST_PASSWORD)
        if (HOST_PASSWORD && password !== HOST_PASSWORD) {
            return socket.emit('announce', 'Incorrect host password.');
        }
        // If HOST_PASSWORD is null, or password matches, proceed.

        // 3. Promote the player
        const newHost = players.find(p => p.socketId === socket.id);
        if (!newHost) { return; } // Safety check

        newHost.isHost = true;
        newHost.isReady = true; // Host is always ready

        // 4. Re-order the array
        const newHostPlayerObject = players.find(p => p.playerId === newHost.playerId);
        players = players.filter(p => p.playerId !== newHost.playerId);
        players.unshift(newHostPlayerObject); // Add to the front (index 0)

        // 5. Broadcast the new lobby state
        io.emit('lobbyUpdate', players);

        // --- ROBO: prompt the new host to configure AI players ---
        socket.emit('showRoboConfig');
    });
    // --- *** END NEW HANDLER *** ---

    // --- ROBO: addRobos handler ---
    socket.on('addRobos', ({ roboConfigs }) => {
        if (gameState) return; // Game already started
        const host = players.find(p => p.socketId === socket.id && p.isHost);
        if (!host) return socket.emit('announce', 'Only the host can configure AI players.');

        if (!Array.isArray(roboConfigs)) return;

        // Remove all existing robos (clean replace)
        const existingRoboIds = players.filter(p => p.isRobo).map(p => p.playerId);
        existingRoboIds.forEach(id => roboInstances.delete(id));
        players = players.filter(p => !p.isRobo);

        // Clamp so total seats (existing humans + new robos) never exceeds the max.
        const existingHumanCount = players.length;
        const maxRobosAllowed = Math.max(0, MAX_TOTAL_SEATS - existingHumanCount);
        const validConfigs = roboConfigs.slice(0, maxRobosAllowed).filter(c => c && typeof c === 'object');

        validConfigs.forEach((config, i) => {
            const roboId = `robo-${Date.now()}-${i}-${Math.random().toString(36).substr(2, 4)}`;
            const roboName = (config.name || `Robo${i + 1}`).trim().slice(0, 20) || `Robo${i + 1}`;
            const difficulty = VALID_DIFFICULTIES.includes(config.difficulty) ? config.difficulty : 'Standard';

            const roboInstance = new RoboPlayer(roboId, roboName, difficulty);
            roboInstances.set(roboId, roboInstance);

            players.push({
                playerId: roboId,
                socketId: `robo-socket-${roboId}`,
                name: roboName,
                isHost: false,
                isReady: true, // Robos are always ready
                active: true,
                isRobo: true,
                difficulty: difficulty,
            });
        });

        console.log(`[Robo] ${validConfigs.length} AI player(s) added to lobby by host ${host.name}.`);
        io.emit('lobbyUpdate', players);
    });
    // --- END ROBO addRobos handler ---


    socket.on('setPlayerReady', () => {
        const player = players.find(p => p.socketId === socket.id);
        if (player && !player.isHost) { // --- MODIFIED: Host is always ready
            player.isReady = true;
            io.emit('lobbyUpdate', players);
        }
    });

    socket.on('kickPlayer', ({ playerIdToKick }) => {
        const host = players.find(p => p.socketId === socket.id && p.isHost);
        if (host) {
            roboInstances.delete(playerIdToKick); // --- ROBO: clean up if a robo was kicked ---
            players = players.filter(p => p.playerId !== playerIdToKick);
            io.emit('lobbyUpdate', players);
        }
    });

    // --- *** MODIFIED: startGame Handler *** ---
    socket.on('startGame', () => { // password parameter removed
        const host = players.find(p => p.socketId === socket.id && p.isHost);
        if (host) {
            // Password check REMOVED

            const readyPlayers = players.filter(p => p.isReady && p.active);
            const readyHumans = readyPlayers.filter(p => !p.isRobo);

            if (readyPlayers.length < 2) {
                return socket.emit('announce', 'Not enough ready players to start the game.');
            }
            if (readyHumans.length < 1) {
                return socket.emit('announce', 'At least one human player is required to start the game.');
            }
            if (readyPlayers.length > MAX_TOTAL_SEATS) {
                return socket.emit('announce', `Too many players/AI at the table (max ${MAX_TOTAL_SEATS}).`);
            }

            gameState = setupGame(readyPlayers);
            startNewRound();
        }
    });
    // --- *** END MODIFIED startGame *** ---

    socket.on('startNextRound', () => {
        if (!gameState || gameState.phase !== 'RoundOver') return;
        const me = gameState.players.find(p => p.socketId === socket.id);
        if (me && me.isHost) {
            startNewRound();
        }
    });

    socket.on('endGame', () => {
        const playerInGame = gameState ? gameState.players.find(p => p.socketId === socket.id) : null;
        if (playerInGame && playerInGame.isHost) {
            gameState.isEnding = true; // MODIFIED: Flag the game as ending
            const finalPlayers = gameState.players.filter(p => p.status !== 'Removed');
            players = finalPlayers
                .filter(p => !p.isRobo) // --- ROBO: exclude robos from the lobby list ---
                .map(p => ({
                    playerId: p.playerId, socketId: p.socketId, name: p.name,
                    isHost: p.isHost, active: true, isReady: p.isHost
                }));
            roboInstances.clear(); // --- ROBO ---
            // --- *** MODIFIED: Ensure host is ready after ending *** ---
            const host = players.find(p => p.isHost);
            if(host) host.isReady = true;
            // --- *** END MODIFICATION *** ---
            gameState = null;
            io.emit('lobbyUpdate', players);
        }
    });

    socket.on('endSession', () => {
        const host = players.find(p => p.socketId === socket.id && p.isHost);
        if (host) {
            players.forEach(p => {
                // --- ROBO: robos have no real socket to disconnect; skip ---
                if (p.socketId !== host.socketId && !p.isRobo) {
                    io.to(p.socketId).emit('forceDisconnect');
                }
            });
            players = [host];
            roboInstances.clear(); // --- ROBO ---
            if (host) host.isReady = true;
            io.emit('lobbyUpdate', players);
        }
    });

    // MODIFIED: Added hard reset handler
    socket.on('hardReset', () => {
        const host = players.find(p => p.socketId === socket.id && p.isHost);
        if (host) {
            // Disconnect all other players
            players.forEach(p => {
                // --- ROBO: robos have no real socket to disconnect; skip ---
                if (p.socketId !== host.socketId && !p.isRobo) {
                    io.to(p.socketId).emit('forceDisconnect');
                }
            });

            // Clear all game state
            gameState = null;
            Object.keys(reconnectTimers).forEach(key => {
                clearTimeout(reconnectTimers[key]);
                delete reconnectTimers[key];
            });
            if (gameOverCleanupTimer) {
                clearTimeout(gameOverCleanupTimer);
                gameOverCleanupTimer = null;
            }
            roboInstances.clear(); // --- ROBO ---

            // Reset lobby to just the host
            host.isReady = true; // Explicitly set the host object's state
            players = [host];    // Re-create the array with only this modified host object

            // Update the host's UI, which effectively updates everyone as they've been kicked
            io.emit('lobbyUpdate', players);
        }
    });

    socket.on('markPlayerAFK', ({ playerIdToMark }) => {
        if (!gameState || gameState.isPaused) return;
        const host = gameState.players.find(p => p.socketId === socket.id && p.isHost);
        if (!host) return;

        const playerToMark = gameState.players.find(p => p.playerId === playerIdToMark);
        if (!playerToMark || playerToMark.status !== 'Active') return;
        if (playerToMark.isRobo) return; // --- ROBO: AFK-marking has no meaning for a robo ---

        playerToMark.status = 'Disconnected';
        addLog(`Host ${host.name} marked ${playerToMark.name} as AFK. The game is paused.`);

        gameState.isPaused = true;
        gameState.pausedForPlayerNames = gameState.players.filter(p => p.status === 'Disconnected').map(p => p.name);
        gameState.pauseEndTime = Date.now() + DISCONNECT_GRACE_PERIOD;

        io.to(playerToMark.socketId).emit('youWereMarkedAFK');

        if (reconnectTimers[playerToMark.playerId]) clearTimeout(reconnectTimers[playerToMark.playerId]);
        reconnectTimers[playerToMark.playerId] = setTimeout(() => {
            handlePlayerRemoval(playerToMark.playerId);
        }, DISCONNECT_GRACE_PERIOD);

        io.emit('updateGameState', gameState);
    });

    socket.on('playerIsBack', () => {
        if (!gameState || !gameState.isPaused) return;
        const player = gameState.players.find(p => p.socketId === socket.id);

        if (player && player.status === 'Disconnected') {
            player.status = 'Active';
            clearTimeout(reconnectTimers[player.playerId]);
            delete reconnectTimers[player.playerId];

            const stillDisconnected = gameState.players.filter(p => p.status === 'Disconnected');
            if (stillDisconnected.length === 0) {
                gameState.isPaused = false;
                gameState.pauseEndTime = null;
                gameState.pausedForPlayerNames = [];
            } else {
                gameState.pausedForPlayerNames = stillDisconnected.map(p => p.name);
            }
            addLog(`Player ${player.name} is back.`);
            io.emit('updateGameState', gameState);
            scheduleRoboTurnIfNeeded(); // --- ROBO: game may have resumed with a robo's turn pending ---
        }
    });

    socket.on('submitBid', ({ bid }) => {
        if (!gameState || gameState.phase !== 'Bidding' || gameState.isPaused) return;
        const playerIndex = gameState.biddingPlayerIndex;
        const player = gameState.players[playerIndex];
        if (!player || player.socketId !== socket.id) return;
        const proposedBid = parseInt(bid);

        const result = applyBid(playerIndex, proposedBid);
        if (!result.ok) {
            if (result.message) socket.emit('invalidBid', { message: result.message });
            return;
        }
        io.emit('updateGameState', gameState);
        scheduleRoboTurnIfNeeded(); // --- ROBO: next bidder (or player) may be a robo ---
    });

    socket.on('playCard', ({ card }) => {
        if (!gameState || gameState.phase !== 'Playing' || gameState.isPaused) return;
        const playerIndex = gameState.currentPlayerIndex;
        const player = gameState.players[playerIndex];
        if (!player || player.socketId !== socket.id) return;

        const result = applyCardPlay(playerIndex, card);
        if (!result.ok) {
            if (result.message) socket.emit('announce', result.message);
            return;
        }
        // If the trick just completed, evaluateTrick() already emitted the
        // updated state and scheduled the TrickReview timer — nothing more
        // to do here (that timer's callback schedules any robo turn needed
        // for the next trick). Only emit/schedule ourselves when play
        // continues within the same trick.
        if (!result.trickCompleted) {
            io.emit('updateGameState', gameState);
            scheduleRoboTurnIfNeeded(); // --- ROBO: next player in this trick may be a robo ---
        }
    });

    socket.on('rearrangeHand', ({ newHand }) => { if (!gameState) return; const player = gameState.players.find(p => p.socketId === socket.id); if (player && newHand.length === player.hand.length) { player.hand = newHand; io.emit('updateGameState', gameState); } });

    // --- *** MODIFIED: disconnect Handler *** ---
    socket.on('disconnect', () => {
        if (gameState) {
            // Game is in progress
            if (gameState.isEnding) {
                return; // Do nothing if game is already ending
            }

            const playerInGame = gameState.players.find(p => p.socketId === socket.id && p.status === 'Active');
            if (playerInGame) {
                playerInGame.status = 'Disconnected';
                addLog(`Player ${playerInGame.name} has disconnected. The game is paused.`);
                gameState.isPaused = true;
                gameState.pausedForPlayerNames = gameState.players.filter(p => p.status === 'Disconnected').map(p => p.name);
                gameState.pauseEndTime = Date.now() + DISCONNECT_GRACE_PERIOD;
                if (reconnectTimers[playerInGame.playerId]) clearTimeout(reconnectTimers[playerInGame.playerId]);
                reconnectTimers[playerInGame.playerId] = setTimeout(() => {
                    handlePlayerRemoval(playerInGame.playerId);
                }, DISCONNECT_GRACE_PERIOD);
                io.emit('updateGameState', gameState);
            }
        } else {
            // We are in the lobby
            const disconnectedPlayer = players.find(p => p.socketId === socket.id);
            if (disconnectedPlayer) {
                disconnectedPlayer.active = false; // Mark as inactive
                
                if (disconnectedPlayer.isHost) {
                    disconnectedPlayer.isHost = false; // Revoke host status
                    // Force all other players to be "not ready"
                    players.forEach(p => {
                        if (p.playerId !== disconnectedPlayer.playerId) {
                            p.isReady = false;
                        }
                    });
                }
                
                io.emit('lobbyUpdate', players);
            }
        }
    });
    // --- *** END MODIFIED disconnect *** ---
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`✅ Judgment Clubhouse Server is live on port ${PORT}`));