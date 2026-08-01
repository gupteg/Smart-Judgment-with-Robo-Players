const { DecisionEngine, TUNING } = require('../server-src/decision-engine');
const { CardMemory } = require('../server-src/card-memory');
const { RoundContext } = require('../server-src/round-context');
const { ExpertStrategy, StandardStrategy } = require('../server-src/strategy');

function card(suit, rank) { return { suit, rank }; }
let pass = 0, fail = 0;
function check(label, ok, extra = '') {
    if (ok) { pass++; console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`); }
    else    { fail++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
}

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 1. Bidding: A,K,Q of a side suit is worth ~3 tricks, not ~1 ===');
// The original engine scored non-top cards at a flat 0.05, so A-K-Q scored
// 0.80 total and the Expert tier then down-weighted the Ace as well.
const akq = [
    card('Hearts', 'A'), card('Hearts', 'K'), card('Hearts', 'Q'),
    card('Hearts', '4'), card('Hearts', '3'), card('Hearts', '2'),
];
const dNT = DecisionEngine.estimateBidExpertDetailed(akq, 'No Trump', 6, { numActivePlayers: 4 });
const dTr = DecisionEngine.estimateBidExpertDetailed(akq, 'Spades', 6, { numActivePlayers: 4 });
console.log(`  No Trump : expected ${dNT.expected.toFixed(2)} tricks → bid ${dNT.bid}`);
console.log(`  Spades tr: expected ${dTr.expected.toFixed(2)} tricks → bid ${dTr.bid}`);
check('No Trump AKQ432 bids at least 3', dNT.bid >= 3, `bid ${dNT.bid}`);
check('Trump round discounts it (ruff risk)', dTr.bid < dNT.bid, `${dTr.bid} < ${dNT.bid}`);
check('Old engine underbid this hand', DecisionEngine.estimateBidStandard(akq, 'Spades', 6) <= 1);

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 2. In-play factor: fewer cards dealt = less contested ===');
const factorSmall = DecisionEngine.inPlayFactorAtBid(6, 4);   // 24 of 52 dealt
const factorFull  = DecisionEngine.inPlayFactorAtBid(13, 4);  // whole deck dealt
console.log(`  4p x 6 cards -> ${factorSmall.toFixed(3)} | 4p x 13 cards -> ${factorFull.toFixed(3)}`);
check('Short round: unseen high cards mostly undealt', factorSmall < 0.45);
check('Full deal: every unseen card is live', Math.abs(factorFull - 1) < 0.001);

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 3. Bidding: bare Ace still counts, junk hand bids 0 ===');
const bareAce = [
    card('Hearts', 'A'), card('Clubs', '5'), card('Clubs', '6'),
    card('Clubs', '7'), card('Diamonds', '2'), card('Diamonds', '3'),
];
const bAce = DecisionEngine.estimateBidExpertDetailed(bareAce, 'Spades', 6, { numActivePlayers: 4 });
check('Bare ace hand bids at least 1', bAce.bid >= 1, `bid ${bAce.bid}, exp ${bAce.expected.toFixed(2)}`);

const junk = [
    card('Hearts', '2'), card('Hearts', '4'), card('Clubs', '3'),
    card('Clubs', '5'), card('Diamonds', '2'), card('Diamonds', '6'),
];
const bJunk = DecisionEngine.estimateBidExpertDetailed(junk, 'Spades', 6, { numActivePlayers: 4 });
check('Junk hand bids 0', bJunk.bid === 0, `bid ${bJunk.bid}, exp ${bJunk.expected.toFixed(2)}`);

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 4. Bidding: strong trump hand ===');
// AKQ5 of trump + a side ace in a 6-card round is realistically 3-4 tricks.
const strongTrump = [
    card('Spades', 'A'), card('Spades', 'K'), card('Spades', 'Q'), card('Spades', '5'),
    card('Hearts', 'A'), card('Clubs', '3'),
];
const bStrong = DecisionEngine.estimateBidExpertDetailed(strongTrump, 'Spades', 6, { numActivePlayers: 4 });
console.log(`  expected ${bStrong.expected.toFixed(2)} -> bid ${bStrong.bid}`);
check('Strong trump hand bids 3+', bStrong.bid >= 3, `bid ${bStrong.bid}`);

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 5. B7/B12 shading direction: high prior bids shade DOWN ===');
const mid = [
    card('Spades', 'A'), card('Spades', '4'), card('Hearts', 'K'),
    card('Hearts', '3'), card('Clubs', 'Q'), card('Clubs', '2'),
];
const noPrior   = DecisionEngine.estimateBidExpertDetailed(mid, 'Spades', 6, { numActivePlayers: 4, bidsBefore: [] });
const highPrior = DecisionEngine.estimateBidExpertDetailed(mid, 'Spades', 6, { numActivePlayers: 4, bidsBefore: [4, 3, 3] });
const lowPrior  = DecisionEngine.estimateBidExpertDetailed(mid, 'Spades', 6, { numActivePlayers: 4, bidsBefore: [0, 0, 1] });
console.log(`  no prior ${noPrior.expected.toFixed(2)} | prior 10 -> ${highPrior.expected.toFixed(2)} | prior 1 -> ${lowPrior.expected.toFixed(2)}`);
check('Heavy prior bids reduce my estimate', highPrior.expected < noPrior.expected);
check('Light prior bids nudge it up', lowPrior.expected > noPrior.expected);

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 6. B10: bidding 0 has zero downside, so weak hands take it ===');
const dist = DecisionEngine.trickDistribution([0.2, 0.2, 0.15, 0.1]);
const ev = DecisionEngine.bestBidByEV(dist, 4, null);
const evRow0 = ev.table.find(r => r.bid === 0);
check('EV(0) equals 10 * P(0)', Math.abs(evRow0.ev - 10 * evRow0.p) < 1e-9);
check('Distribution sums to 1', Math.abs(dist.reduce((a, b) => a + b, 0) - 1) < 1e-9);

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 7. Hook rule: no longer always rounds down ===');
const forb = DecisionEngine.getForbiddenBid(10, 13, true);
check('Forbidden value computed', forb === 3, `got ${forb}`);
const downish = DecisionEngine.resolveLegalBid(3, 13, 3, { evTable: [{ bid: 2, ev: 5 }, { bid: 4, ev: 1 }] });
const upish   = DecisionEngine.resolveLegalBid(3, 13, 3, { evTable: [{ bid: 2, ev: 1 }, { bid: 4, ev: 5 }] });
check('Picks the better-EV neighbour (down)', downish === 2, `got ${downish}`);
check('Picks the better-EV neighbour (up)', upish === 4, `got ${upish}`);
check('Cannot go below 0', DecisionEngine.resolveLegalBid(0, 13, 0) === 1);
check('Not last bidder -> no forbidden value', DecisionEngine.getForbiddenBid(10, 13, false) === null);

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 8. Mode D split (R14) ===');
check('Busted high -> D', DecisionEngine.getPlayMode(2, 3, 5, 3) === 'D');
check('Busted low (unreachable) -> D', DecisionEngine.getPlayMode(4, 0, 5, 3) === 'D');
check('Met exactly -> B', DecisionEngine.getPlayMode(2, 2, 5, 2) === 'B');
check('Need all remaining -> A', DecisionEngine.getPlayMode(3, 0, 5, 2) === 'A');
check('Mixed -> C', DecisionEngine.getPlayMode(2, 0, 5, 1) === 'C');

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 9. R9: trump-aware card cost ===');
const ctx9 = { trumpSuit: 'Spades' };
const trump2 = DecisionEngine.cardCost(card('Spades', '2'), ctx9);
const sideQ  = DecisionEngine.cardCost(card('Hearts', 'Q'), ctx9);
check('Trump 2 costs more than a side-suit Queen', trump2 > sideQ, `${trump2} > ${sideQ}`);

// ═══════════════════════════════════════════════════════════════════════
// Live play tests need a fake game state.
// ═══════════════════════════════════════════════════════════════════════
function makeGS({ myHand, trump = 'Spades', handSize = 6, bid = 2, tricksWon = 0,
                  currentTrick = [], leadSuit = null, opponents = [] }) {
    const players = [
        { playerId: 'me', name: 'Robo', hand: myHand, bid, tricksWon, status: 'Active', score: 0 },
        ...opponents.map((o, i) => ({
            playerId: o.id || `p${i + 1}`, name: o.name || `P${i + 1}`, hand: new Array(myHand.length).fill(null),
            bid: o.bid ?? 1, tricksWon: o.tricksWon ?? 0, status: 'Active', score: o.score ?? 0,
        })),
    ];
    return {
        players, trumpSuit: trump, numCardsToDeal: handSize,
        currentTrick, leadSuit, phase: 'Playing',
    };
}

function makeBrain(bids = {}, trickWinners = [], handSize = 6, trump = 'Spades') {
    const memory = new CardMemory();
    const round = new RoundContext('me');
    round.reset({ handSize, trumpSuit: trump });
    Object.entries(bids).forEach(([pid, b]) => round.recordBid(pid, b));
    round.markBiddingComplete();
    trickWinners.forEach(w => round.recordTrickWinner(w));
    return { memory, round };
}

const expert = new ExpertStrategy();

// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== 10. R4: safe high discard — shed the King under the Ace ===');
(async () => {
    const gs = makeGS({
        myHand: [card('Hearts', 'K'), card('Hearts', '3'), card('Clubs', '9'), card('Clubs', '2')],
        trump: 'Spades', handSize: 4, bid: 0, tricksWon: 0,
        leadSuit: 'Hearts',
        currentTrick: [{ playerId: 'p1', name: 'P1', card: card('Hearts', 'A') }],
        opponents: [{ id: 'p1', bid: 2 }, { id: 'p2', bid: 1 }, { id: 'p3', bid: 0 }],
    });
    const brain = makeBrain({ me: 0, p1: 2, p2: 1, p3: 0 }, [], 4);
    brain.memory.recordCard(card('Hearts', 'A'), 'p1');
    const res = await expert.selectCard(gs, 0, brain, { tricksPlayedSoFar: 0, tricksRemaining: 4, playersYetToAct: 2 });
    console.log(`  played ${res.card.rank} of ${res.card.suit}`);
    check('Sheds the King rather than the 3', res.card.rank === 'K', `played ${res.card.rank}`);

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== 11. R13: nil bidder never leads a bankable Ace ===');
    const gs2 = makeGS({
        myHand: [card('Hearts', 'A'), card('Clubs', '4'), card('Diamonds', '3'), card('Diamonds', '2')],
        trump: 'Spades', handSize: 4, bid: 0, tricksWon: 0,
        leadSuit: null, currentTrick: [],
        opponents: [{ id: 'p1', bid: 2 }, { id: 'p2', bid: 1 }, { id: 'p3', bid: 2 }],
    });
    const brain2 = makeBrain({ me: 0, p1: 2, p2: 1, p3: 2 }, [], 4);
    const res2 = await expert.selectCard(gs2, 0, brain2, { tricksPlayedSoFar: 0, tricksRemaining: 4, playersYetToAct: 3 });
    console.log(`  led ${res2.card.rank} of ${res2.card.suit}`);
    check('Does not lead the Ace while shedding', res2.card.rank !== 'A', `led ${res2.card.rank}`);
    check('Leads a low card', ['2', '3', '4'].includes(res2.card.rank), `led ${res2.card.rank}`);

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== 12. R6: forced to win -> dump the biggest, not the smallest ===');
    const gs3 = makeGS({
        myHand: [card('Hearts', 'A'), card('Hearts', 'K')],
        trump: 'Spades', handSize: 4, bid: 1, tricksWon: 1,
        leadSuit: 'Hearts',
        currentTrick: [{ playerId: 'p1', name: 'P1', card: card('Hearts', '5') }],
        opponents: [{ id: 'p1', bid: 1 }, { id: 'p2', bid: 1 }, { id: 'p3', bid: 0 }],
    });
    const brain3 = makeBrain({ me: 1, p1: 1, p2: 1, p3: 0 }, ['me', 'p1'], 4);
    const res3 = await expert.selectCard(gs3, 0, brain3, { tricksPlayedSoFar: 2, tricksRemaining: 2, playersYetToAct: 2 });
    console.log(`  played ${res3.card.rank} of ${res3.card.suit}`);
    check('Plays the Ace (winning anyway, so burn the liability)', res3.card.rank === 'A', `played ${res3.card.rank}`);

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== 13. R14/S2: busted robo denies a chaser ===');
    const gs4 = makeGS({
        myHand: [card('Hearts', 'K'), card('Hearts', '2'), card('Clubs', '5')],
        trump: 'Spades', handSize: 5, bid: 1, tricksWon: 3,   // busted high -> mode D
        leadSuit: 'Hearts',
        currentTrick: [{ playerId: 'p1', name: 'Chaser', card: card('Hearts', 'Q') }],
        opponents: [
            { id: 'p1', name: 'Chaser', bid: 3, tricksWon: 1, score: 40 },
            { id: 'p2', name: 'Safe',   bid: 1, tricksWon: 1, score: 10 },
        ],
    });
    const brain4 = makeBrain({ me: 1, p1: 3, p2: 1 }, ['me', 'me', 'me', 'p1'], 5);
    const res4 = await expert.selectCard(gs4, 0, brain4, { tricksPlayedSoFar: 4, tricksRemaining: 1, playersYetToAct: 1 });
    console.log(`  played ${res4.card.rank} of ${res4.card.suit} — ${res4.trace.headline}`);
    check('Overtakes the chaser rather than ducking', res4.card.rank === 'K', `played ${res4.card.rank}`);
    check('Posture is SABOTAGE', res4.trace.headline.startsWith('SABOTAGE'));

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== 14. R2/R3: unexpected trick -> stops grabbing, sheds surplus ===');
    // Bid 1, already won it, still holding a bankable Ace. Should duck.
    const gs5 = makeGS({
        myHand: [card('Hearts', 'A'), card('Hearts', '2'), card('Clubs', '4')],
        trump: 'Spades', handSize: 5, bid: 1, tricksWon: 1,
        leadSuit: 'Hearts',
        currentTrick: [{ playerId: 'p1', name: 'P1', card: card('Hearts', '9') }],
        opponents: [{ id: 'p1', bid: 2, tricksWon: 1 }, { id: 'p2', bid: 2, tricksWon: 0 }],
    });
    const brain5 = makeBrain({ me: 1, p1: 2, p2: 2 }, ['me', 'p1'], 5);
    const res5 = await expert.selectCard(gs5, 0, brain5, { tricksPlayedSoFar: 2, tricksRemaining: 3, playersYetToAct: 1 });
    console.log(`  played ${res5.card.rank} of ${res5.card.suit} — ${res5.trace.headline}`);
    check('Ducks with the 2 rather than winning with the Ace', res5.card.rank === '2', `played ${res5.card.rank}`);

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== 15. T1: table regime is computed and available ===');
    const r = new RoundContext('me');
    r.reset({ handSize: 6 });
    r.recordBid('me', 2); r.recordBid('p1', 1); r.recordBid('p2', 1); r.recordBid('p3', 1);
    r.markBiddingComplete();
    check('Surplus = handSize - sum(bids)', r.tableSurplus() === 1, `got ${r.tableSurplus()}`);
    check('Regime is under', r.regime() === 'under');
    r.reset({ handSize: 6 });
    r.recordBid('me', 3); r.recordBid('p1', 3); r.recordBid('p2', 2);
    check('Regime is over', r.regime() === 'over', `surplus ${r.tableSurplus()}`);

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== 16. Standard tier behaviour unchanged ===');
    const std = new StandardStrategy();
    const gs6 = makeGS({
        myHand: [card('Hearts', 'K'), card('Hearts', '3')],
        trump: 'Spades', handSize: 4, bid: 0, tricksWon: 0,
        leadSuit: 'Hearts',
        currentTrick: [{ playerId: 'p1', name: 'P1', card: card('Hearts', 'A') }],
        opponents: [{ id: 'p1', bid: 2 }],
    });
    const res6 = await std.selectCard(gs6, 0, makeBrain({}, [], 4), { tricksPlayedSoFar: 2, tricksRemaining: 2 });
    check('Standard still ducks with its lowest card (naive)', res6.card.rank === '3', `played ${res6.card.rank}`);
    check('Standard bid estimator unchanged', DecisionEngine.estimateBidStandard(akq, 'Spades', 6) === 1);

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== 17. Legality & trick resolution (regression) ===');
    const hand5 = [card('Hearts', '5'), card('Hearts', '9'), card('Clubs', 'K')];
    check('Must follow suit when able', DecisionEngine.getLegalCards(hand5, 'Hearts').length === 2);
    check('Void -> anything legal', DecisionEngine.getLegalCards(hand5, 'Diamonds').length === 3);
    const trick = [
        { playerId: 'p1', card: card('Hearts', 'A') },
        { playerId: 'p2', card: card('Spades', '2') },
    ];
    check('Trump beats non-trump', DecisionEngine.getTrickWinner(trick, 'Spades').playerId === 'p2');

    console.log(`\n${'='.repeat(60)}`);
    console.log(`${pass} passed, ${fail} failed`);
    console.log('='.repeat(60));
    process.exit(fail > 0 ? 1 : 0);
})();
