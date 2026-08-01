'use strict';

/**
 * DecisionEngine — pure, static, side-effect-free heuristic utilities shared
 * by both Standard and Expert strategies.
 *
 * Mirrors the card values already defined in server.js so robo legality
 * checks and trick-winner logic stay in sync with what the server enforces.
 */

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUES = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
const SUITS = ['Spades', 'Hearts', 'Diamonds', 'Clubs'];

class DecisionEngine {

    // ─────────────────────────────────────────────────────────────────
    // LEGALITY (mirrors server.js's follow-suit rule)
    // ─────────────────────────────────────────────────────────────────

    /**
     * Return all legal cards from a hand as { card, index } pairs, given the
     * suit currently led (null if this robo is leading the trick).
     * @param {Array} hand
     * @param {string|null} leadSuit
     * @returns {Array<{card:object, index:number}>}
     */
    static getLegalCards(hand, leadSuit) {
        const withIndex = hand.map((card, index) => ({ card, index }));
        if (!leadSuit) return withIndex;
        const followable = withIndex.filter(c => c.card.suit === leadSuit);
        return followable.length > 0 ? followable : withIndex;
    }

    // ─────────────────────────────────────────────────────────────────
    // TRICK RESOLUTION (mirrors server.js's updateCurrentWinner)
    // ─────────────────────────────────────────────────────────────────

    /**
     * Given a completed or in-progress trick (array of {playerId, card}) plus
     * one hypothetical additional card, determine whether that card would
     * currently be winning the trick if played.
     * @param {{suit:string, rank:string}} card
     * @param {Array<{card:object}>} trickSoFar
     * @param {string} trumpSuit
     * @returns {boolean}
     */
    static wouldWinTrick(card, trickSoFar, trumpSuit) {
        if (trickSoFar.length === 0) return true;
        const hypothetical = [...trickSoFar, { card }];
        const winner = DecisionEngine.getTrickWinner(hypothetical, trumpSuit);
        return winner === hypothetical[hypothetical.length - 1];
    }

    /**
     * @param {Array<{card:object}>} trick
     * @param {string} trumpSuit
     * @returns {object} the winning entry from `trick`
     */
    static getTrickWinner(trick, trumpSuit) {
        let winner = trick[0];
        for (let i = 1; i < trick.length; i++) {
            const current = trick[i];
            if (winner.card.suit === trumpSuit && current.card.suit !== trumpSuit) continue;
            if (winner.card.suit !== trumpSuit && current.card.suit === trumpSuit) { winner = current; continue; }
            if (current.card.suit === winner.card.suit && RANK_VALUES[current.card.rank] > RANK_VALUES[winner.card.rank]) {
                winner = current;
            }
        }
        return winner;
    }

    // ─────────────────────────────────────────────────────────────────
    // HAND GROUPING HELPERS
    // ─────────────────────────────────────────────────────────────────

    /**
     * Group a hand by suit, each group sorted highest rank first.
     * @param {Array} hand
     * @returns {Object<string, Array>}
     */
    static groupBySuit(hand) {
        const groups = {};
        SUITS.forEach(s => groups[s] = []);
        hand.forEach(card => {
            if (!groups[card.suit]) groups[card.suit] = [];
            groups[card.suit].push(card);
        });
        Object.keys(groups).forEach(s => {
            groups[s].sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank]);
        });
        return groups;
    }

    // ─────────────────────────────────────────────────────────────────
    // BID ESTIMATION — shared per-card scoring (Standard tier baseline)
    // ─────────────────────────────────────────────────────────────────

    /**
     * Naive per-card win-probability score. Used directly by Standard tier;
     * used as the starting point (before buffer/exposure adjustment) by
     * Expert tier.
     * @param {object} card
     * @param {boolean} isTrump
     * @param {number} positionFromTop - 0 = highest card of this suit in hand
     * @returns {number}
     */
    static cardBaseScore(card, isTrump, positionFromTop) {
        if (isTrump) {
            if (card.rank === 'A') return 0.9;
            if (card.rank === 'K') return positionFromTop <= 1 ? 0.8 : 0.5;
            if (card.rank === 'Q' || card.rank === 'J') return positionFromTop <= 1 ? 0.6 : 0.35;
            return positionFromTop === 0 ? 0.4 : 0.25;
        }
        // Non-trump: only the very top of a suit has any real win chance,
        // and even then only if trump exists to worry about, or it's a
        // No Trump round where the top card of a suit is a real winner.
        if (positionFromTop === 0 && card.rank === 'A') return 0.7;
        if (positionFromTop === 0 && card.rank === 'K') return 0.45;
        return 0.05;
    }

    /**
     * Void/short-suit ruffing bonus: holding few cards in a non-trump suit
     * while holding trump gives some chance of winning a later trick by
     * ruffing once that suit is exhausted.
     * @param {number} suitCount - cards held in this non-trump suit
     * @param {number} trumpCount - cards held in trump
     * @returns {number}
     */
    static ruffBonus(suitCount, trumpCount) {
        if (trumpCount === 0) return 0;
        if (suitCount === 0) return Math.min(0.3, trumpCount * 0.15);
        if (suitCount === 1) return Math.min(0.15, trumpCount * 0.08);
        return 0;
    }

    /**
     * STANDARD TIER bid estimate: sum naive per-card scores, no buffer/
     * exposure adjustment, no bidding-order awareness.
     * @param {Array} hand
     * @param {string} trumpSuit - 'No Trump' is a valid value (no suit is trump)
     * @param {number} handSize
     * @returns {number} integer bid estimate, clamped to [0, handSize]
     */
    static estimateBidStandard(hand, trumpSuit, handSize) {
        const groups = DecisionEngine.groupBySuit(hand);
        let score = 0;
        Object.entries(groups).forEach(([suit, cards]) => {
            const isTrump = suit === trumpSuit;
            cards.forEach((card, idx) => {
                score += DecisionEngine.cardBaseScore(card, isTrump, idx);
            });
        });
        const trumpCount = trumpSuit !== 'No Trump' ? (groups[trumpSuit]?.length || 0) : 0;
        Object.entries(groups).forEach(([suit, cards]) => {
            if (suit === trumpSuit) return;
            score += DecisionEngine.ruffBonus(cards.length, trumpCount);
        });
        return Math.max(0, Math.min(handSize, Math.round(score)));
    }

    // ─────────────────────────────────────────────────────────────────
    // BID ESTIMATION — Expert tier: buffer/exposure model
    // ─────────────────────────────────────────────────────────────────

    /**
     * Estimate how many times a suit is likely to be led before the round
     * ends, based purely on public information available at bid time
     * (hand size and player count — no play has happened yet).
     * @param {number} handSize
     * @param {number} numActivePlayers
     * @returns {number}
     */
    static estimateExposurePrior(handSize, numActivePlayers) {
        // Rough prior: assume most active players are reasonably likely to
        // hold and eventually lead this suit at least once if their hand
        // is large enough; scales down as hand size shrinks (fewer total
        // leads possible in the round) and as player count grows (more
        // suits competing to be led).
        if (numActivePlayers <= 0) return 0;
        return Math.min(handSize, (handSize * Math.max(1, numActivePlayers - 1)) / numActivePlayers);
    }

    /**
     * Buffer/exposure-aware danger score for a suit holding at bid time.
     * danger ≈ 0 means the suit's high cards are likely safe discards
     * (enough low-card buffer to dodge being forced to win); danger > 0
     * means the high card(s) are likely forced winners.
     * @param {Array} suitCards - this suit's cards from the hand, sorted high-to-low
     * @param {number} handSize
     * @param {number} numActivePlayers
     * @returns {number}
     */
    static suitDangerAtBidTime(suitCards, handSize, numActivePlayers) {
        const buffer = Math.max(0, suitCards.length - 1); // low-card cushion below the top card
        const exposure = DecisionEngine.estimateExposurePrior(handSize, numActivePlayers);
        return Math.max(0, exposure - buffer);
    }

    /**
     * EXPERT TIER bid estimate: applies the buffer/exposure model to every
     * non-trump suit holding, down-weighting high cards that are backed by
     * enough low cards to likely be dodged, then applies bidding-order
     * awareness (bumps estimate slightly if bids already placed are high
     * relative to hand size, signalling less competition for tricks).
     * @param {Array} hand
     * @param {string} trumpSuit
     * @param {number} handSize
     * @param {object} context - { numActivePlayers, bidsSoFar (array of numbers already bid this round) }
     * @returns {number} integer bid estimate, clamped to [0, handSize]
     */
    static estimateBidExpert(hand, trumpSuit, handSize, context = {}) {
        const { numActivePlayers = 4, bidsSoFar = [] } = context;
        const groups = DecisionEngine.groupBySuit(hand);
        let score = 0;

        Object.entries(groups).forEach(([suit, cards]) => {
            const isTrump = suit === trumpSuit;
            if (isTrump) {
                cards.forEach((card, idx) => { score += DecisionEngine.cardBaseScore(card, true, idx); });
                return;
            }
            // Non-trump suit: apply buffer/exposure down-weighting.
            const danger = DecisionEngine.suitDangerAtBidTime(cards, handSize, numActivePlayers);
            cards.forEach((card, idx) => {
                const base = DecisionEngine.cardBaseScore(card, false, idx);
                if (idx === 0 && danger <= 0.1) {
                    // Top card of this suit is very likely dodgeable — treat
                    // as a near-safe discard rather than a forced winner.
                    score += base * 0.15;
                } else if (idx === 0) {
                    // Some danger remains — scale proportionally.
                    const dangerFactor = Math.min(1, danger / 2);
                    score += base * (0.15 + 0.85 * dangerFactor);
                } else {
                    score += base; // low cards contribute their (small) baseline only
                }
            });
        });

        const trumpCount = trumpSuit !== 'No Trump' ? (groups[trumpSuit]?.length || 0) : 0;
        Object.entries(groups).forEach(([suit, cards]) => {
            if (suit === trumpSuit) return;
            score += DecisionEngine.ruffBonus(cards.length, trumpCount);
        });

        // Bidding-order awareness: if total bids placed so far already use
        // up a large share of the hand, competition for remaining tricks is
        // lower, so nudge our estimate up slightly.
        if (bidsSoFar.length > 0) {
            const sumSoFar = bidsSoFar.reduce((a, b) => a + b, 0);
            const fractionUsed = handSize > 0 ? sumSoFar / handSize : 0;
            if (fractionUsed >= 0.6) score += 0.5;
        }

        return Math.max(0, Math.min(handSize, Math.round(score)));
    }

    // ─────────────────────────────────────────────────────────────────
    // BID LEGALITY (hook rule)
    // ─────────────────────────────────────────────────────────────────

    /**
     * If this robo is the last bidder, compute the forbidden bid value
     * (the one that would make total bids equal handSize). Returns null
     * if this robo is not the last bidder, or there is no forbidden value
     * in range.
     * @param {number} bidsSoFarSum
     * @param {number} handSize
     * @param {boolean} isLastBidder
     * @returns {number|null}
     */
    static getForbiddenBid(bidsSoFarSum, handSize, isLastBidder) {
        if (!isLastBidder) return null;
        const forbidden = handSize - bidsSoFarSum;
        return (forbidden >= 0 && forbidden <= handSize) ? forbidden : null;
    }

    /**
     * Adjust a desired bid to respect the hook rule if necessary.
     * @param {number} desiredBid
     * @param {number} handSize
     * @param {number|null} forbiddenBid
     * @returns {number} legal bid closest to desiredBid
     */
    static resolveLegalBid(desiredBid, handSize, forbiddenBid) {
        let bid = Math.max(0, Math.min(handSize, desiredBid));
        if (forbiddenBid === null || bid !== forbiddenBid) return bid;
        // Prefer rounding down (bidding lower) when forced off the forbidden
        // value, unless that would go below 0, in which case round up.
        if (bid - 1 >= 0) return bid - 1;
        return bid + 1;
    }

    // ─────────────────────────────────────────────────────────────────
    // PLAY MODE STATE MACHINE
    // ─────────────────────────────────────────────────────────────────

    /**
     * @param {number} bid
     * @param {number} tricksWonSoFar
     * @param {number} handSize
     * @param {number} tricksPlayedSoFar
     * @returns {'A'|'B'|'C'} play mode:
     *   A = must win every remaining trick
     *   B = must avoid winning (bid already met or exceeded)
     *   C = mixed — win some, duck some
     */
    static getPlayMode(bid, tricksWonSoFar, handSize, tricksPlayedSoFar) {
        const tricksNeeded = bid - tricksWonSoFar;
        const tricksRemaining = handSize - tricksPlayedSoFar;
        if (tricksNeeded <= 0) return 'B';
        if (tricksNeeded >= tricksRemaining) return 'A';
        return 'C';
    }

    // ─────────────────────────────────────────────────────────────────
    // CARD SELECTION HELPERS
    // ─────────────────────────────────────────────────────────────────

    /**
     * From legal cards, find those that would currently win the trick.
     * @param {Array<{card:object,index:number}>} legalCards
     * @param {Array<{card:object}>} trickSoFar
     * @param {string} trumpSuit
     * @returns {Array<{card:object,index:number}>}
     */
    static getWinningCards(legalCards, trickSoFar, trumpSuit) {
        return legalCards.filter(c => DecisionEngine.wouldWinTrick(c.card, trickSoFar, trumpSuit));
    }

    /**
     * Among a set of candidate cards, return the highest-ranked one
     * (used in Mode A: must win, so play the strongest sure thing).
     * @param {Array<{card:object,index:number}>} cards
     * @returns {{card:object,index:number}|null}
     */
    static highestCard(cards) {
        if (cards.length === 0) return null;
        return cards.reduce((best, c) => RANK_VALUES[c.card.rank] > RANK_VALUES[best.card.rank] ? c : best);
    }

    /**
     * Among a set of candidate cards, return the lowest-ranked one
     * (used in Mode B: must duck, so discard the weakest card).
     * @param {Array<{card:object,index:number}>} cards
     * @returns {{card:object,index:number}|null}
     */
    static lowestCard(cards) {
        if (cards.length === 0) return null;
        return cards.reduce((worst, c) => RANK_VALUES[c.card.rank] < RANK_VALUES[worst.card.rank] ? c : worst);
    }

    /**
     * Among winning candidates, return the cheapest one sufficient to win
     * (Expert tier: never burn an Ace of trump if a lower trump would do).
     * @param {Array<{card:object,index:number}>} winningCards
     * @returns {{card:object,index:number}|null}
     */
    static cheapestWinner(winningCards) {
        return DecisionEngine.lowestCard(winningCards);
    }
}

module.exports = { DecisionEngine, RANKS, RANK_VALUES, SUITS };
