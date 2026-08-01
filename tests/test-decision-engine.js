const { DecisionEngine } = require('./server-src/decision-engine');

function card(suit, rank) { return { suit, rank }; }

console.log('=== Test 1: A,K,Q,2,3,4 all in ONE non-trump suit (the buffer/exposure scenario) ===');
const hand1 = [
    card('Hearts', 'A'), card('Hearts', 'K'), card('Hearts', 'Q'),
    card('Hearts', '4'), card('Hearts', '3'), card('Hearts', '2'),
];
const trump1 = 'Spades'; // Hearts is NOT trump
const handSize1 = 6;

const standardBid1 = DecisionEngine.estimateBidStandard(hand1, trump1, handSize1);
const expertBid1 = DecisionEngine.estimateBidExpert(hand1, trump1, handSize1, { numActivePlayers: 4, bidsSoFar: [] });
console.log(`Standard tier bid estimate: ${standardBid1}`);
console.log(`Expert tier bid estimate:   ${expertBid1}`);
console.log(`Expected: Expert should bid LOWER than Standard (buffer/exposure recognizes the low cards as a dodge cushion)`);
console.log(expertBid1 < standardBid1 ? 'PASS: Expert bids lower than Standard on this hand' : 'FAIL: Expert did not bid lower');

console.log('\n=== Test 2: Bare Ace, no buffer (should be treated as a near-certain winner by BOTH tiers) ===');
const hand2 = [
    card('Hearts', 'A'), // bare ace, no low cards behind it
    card('Clubs', '5'), card('Clubs', '6'), card('Clubs', '7'),
    card('Diamonds', '2'), card('Diamonds', '3'),
];
const trump2 = 'Spades';
const handSize2 = 6;
const standardBid2 = DecisionEngine.estimateBidStandard(hand2, trump2, handSize2);
const expertBid2 = DecisionEngine.estimateBidExpert(hand2, trump2, handSize2, { numActivePlayers: 4, bidsSoFar: [] });
console.log(`Standard tier bid estimate: ${standardBid2}`);
console.log(`Expert tier bid estimate:   ${expertBid2}`);
console.log('Expected: both tiers count the bare ace as a likely winner (bid >= 1 from at least one tier)');
console.log((standardBid2 >= 1 || expertBid2 >= 1) ? 'PASS' : 'FAIL: neither tier recognized the bare ace as a winner');

console.log('\n=== Test 3: Hook rule — forbidden bid computation ===');
const forbidden1 = DecisionEngine.getForbiddenBid(10, 13, true); // last bidder, others bid 10 total, hand=13
console.log(`bidsSoFarSum=10, handSize=13, isLastBidder=true -> forbidden bid: ${forbidden1} (expected 3)`);
console.log(forbidden1 === 3 ? 'PASS' : 'FAIL');

const resolved1 = DecisionEngine.resolveLegalBid(3, 13, forbidden1);
console.log(`Desired bid 3 with forbidden=3 resolves to: ${resolved1} (expected 2, rounds down)`);
console.log(resolved1 === 2 ? 'PASS' : 'FAIL');

const forbidden2 = DecisionEngine.getForbiddenBid(13, 13, true); // sum already at handSize with 0 remaining bidder
const resolved2 = DecisionEngine.resolveLegalBid(0, 13, forbidden2);
console.log(`bidsSoFarSum=13, handSize=13 -> forbidden=${forbidden2} (expected 0), desired 0 resolves to ${resolved2} (expected 1, can't go below 0)`);
console.log(forbidden2 === 0 && resolved2 === 1 ? 'PASS' : 'FAIL');

const notLastBidder = DecisionEngine.getForbiddenBid(10, 13, false);
console.log(`isLastBidder=false -> forbidden: ${notLastBidder} (expected null)`);
console.log(notLastBidder === null ? 'PASS' : 'FAIL');

console.log('\n=== Test 4: Play mode state machine ===');
console.log('bid=3, tricksWon=0, handSize=5, tricksPlayedSoFar=2 (3 remaining) -> mode A (need all 3 remaining):',
    DecisionEngine.getPlayMode(3, 0, 5, 2) === 'A' ? 'PASS' : 'FAIL');
console.log('bid=2, tricksWon=2, handSize=5, tricksPlayedSoFar=2 -> mode B (already met bid):',
    DecisionEngine.getPlayMode(2, 2, 5, 2) === 'B' ? 'PASS' : 'FAIL');
console.log('bid=2, tricksWon=0, handSize=5, tricksPlayedSoFar=1 (4 remaining, need 2) -> mode C (mixed):',
    DecisionEngine.getPlayMode(2, 0, 5, 1) === 'C' ? 'PASS' : 'FAIL');

console.log('\n=== Test 5: Legal card / follow-suit logic ===');
const hand5 = [card('Hearts', '5'), card('Hearts', '9'), card('Clubs', 'K')];
const legalWithLead = DecisionEngine.getLegalCards(hand5, 'Hearts');
console.log('Must follow Hearts when holding Hearts:', legalWithLead.length === 2 && legalWithLead.every(c => c.card.suit === 'Hearts') ? 'PASS' : 'FAIL');
const legalVoid = DecisionEngine.getLegalCards(hand5, 'Diamonds');
console.log('Void in led suit -> any card legal:', legalVoid.length === 3 ? 'PASS' : 'FAIL');

console.log('\n=== Test 6: Trick winner resolution (trump beats non-trump regardless of rank) ===');
const trick = [
    { playerId: 'p1', card: card('Hearts', 'A') },
    { playerId: 'p2', card: card('Spades', '2') }, // trump
];
const winner = DecisionEngine.getTrickWinner(trick, 'Spades');
console.log('Spades 2 (trump) beats Hearts Ace (non-trump):', winner.playerId === 'p2' ? 'PASS' : 'FAIL');
