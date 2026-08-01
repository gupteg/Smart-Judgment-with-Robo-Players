'use strict';

/**
 * DecisionEngine — pure, static, side-effect-free heuristics shared by both
 * strategy tiers. Nothing here mutates its arguments or holds state, so every
 * function is directly unit-testable with hand-built plain objects.
 *
 * PHASE 1 REWRITE. The headline changes versus the original engine:
 *
 *  1. IN-PLAY FACTOR (the big one). Only `numPlayers × handSize` of the 52
 *     cards are dealt each round. In a 4-player 6-card round that is 24 cards,
 *     so a King you don't hold is only ~39% likely to exist in anybody's hand.
 *     The old engine implicitly assumed a full deck, which made every holding
 *     look far more contested than it was — a large, systematic underbid.
 *
 *  2. OUTSTANDING-HIGHER-CARDS SCORING (B2) replaces positional scoring.
 *     The old `cardBaseScore` gave any non-trump card below the top of its
 *     suit a flat 0.05, so A-K scored 0.75 and A-K-Q scored 0.80. Both are
 *     worth close to their length in tricks.
 *
 *  3. THE BUFFER/EXPOSURE MODEL IS NO LONGER APPLIED TO BIDDING (see
 *     estimateBidExpert). The original insight — low cards let you dodge
 *     being FORCED to win — is real, but it describes flexibility to bid
 *     LOW, not a reason to expect fewer tricks. Holding A-K-Q of a side suit
 *     you can simply lead them and take three tricks. Down-weighting them to
 *     ~0.2 total was the single largest source of the observed underbidding.
 *     Buffer/exposure now lives where it belongs: in play-time discard
 *     selection and in `dangerScore`.
 *
 *  4. EV-MAXIMISING BID (B10). Judgment scores 10+bid for an exact hit and
 *     -bid for a miss, so bidding 0 has literally zero downside. The engine
 *     now builds a Poisson-binomial distribution over tricks won and picks
 *     the bid maximising expected value rather than rounding a point estimate.
 *
 *  5. SITUATION ASSESSMENT (buildSituation) — a single per-turn snapshot
 *     carrying mode, posture, slack, table regime, bankable/surplus winners
 *     and opponent states, which the Expert strategy reads instead of
 *     recomputing fragments inline.
 */

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUES = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
const SUITS = ['Spades', 'Hearts', 'Diamonds', 'Clubs'];
const NO_TRUMP = 'No Trump';

// ─────────────────────────────────────────────────────────────────────────
// TUNABLE CONSTANTS
// Every magic number in the engine is collected here so Phase 3's self-play
// harness can fit them without hunting through the logic.
// ─────────────────────────────────────────────────────────────────────────
const TUNING = {
    // Bidding
    RUFF_TRUMP_HOLD_PROB:   0.75, // P(an opponent void in a side suit holds trump to ruff with)
    RUFF_DISCOUNT:          0.85, // how much of that ruff probability actually costs us the trick
    ESTABLISH_NO_TRUMP:     0.80, // credit for long-suit low cards once the suit is exhausted (No Trump)
    ESTABLISH_TRUMP_ROUND:  0.22, // same, but in a trump round they usually get ruffed
    ESTABLISH_BASE_P:       0.85, // raw win prob of an established (suit-exhausted) low card
    RUFF_TRICK_VOID:        1.10, // expected extra tricks from a void side suit, given spare trumps
    RUFF_TRICK_SINGLETON:   0.55, // ditto for a singleton
    RUFF_TRICK_DOUBLETON:   0.15, // ditto for a doubleton, only in longer hands
    BID_SHADE_PER_EXCESS:   0.13, // B7/B12 — shading strength per unit of excess claim by prior bidders
    BID_SHADE_MAX:          0.22, // cap on downward shading
    BID_SHADE_MIN:         -0.10, // cap on upward shading when the table has under-claimed
    BID_SHADE_TRUMP_RATIO:  0.40, // trump holdings are less vulnerable to strong opponents than side aces
    SMALL_HAND_CAUTION:     0.90, // EV multiplier on non-zero bids when handSize <= 2 (B15)

    // Calibration of the raw per-card model onto real trick counts.
    //
    // Tricks are zero-sum: across the table, expectations must total exactly
    // handSize. A model that only looks at MY hand cannot enforce that, and
    // reliably drifts optimistic because it implicitly assumes I always get to
    // play each card at the moment it is most likely to win -- which cannot be
    // true for four players simultaneously.
    //
    // These two numbers are a least-squares fit of tricks actually won against
    // raw model output over several thousand simulated rounds
    // (tests/calibrate.js). The raw model's RANKING of hands is good -- it
    // correlates with reality noticeably better than the Standard estimator
    // does -- so only the scale needed correcting, not the logic.
    // OFFSET is in units of the neutral prior (handSize/numPlayers) so the
    // correction scales properly across 1-card and 13-card rounds.
    BID_CALIB_SLOPE:        0.70,
    BID_CALIB_OFFSET:      -0.14,

    // Play
    BANKABLE_THRESHOLD:     0.82, // win probability above which a card counts as a bankable trick
    SLACK_BAND:             0.75, // |effective slack| below this = BALANCE posture
    REGIME_SLACK_NUDGE:     0.40, // T2/T3 — how hard the table regime pushes posture
    SAFE_WIN_THRESHOLD:     0.70, // required survival prob to call a winner "safe" with players still to act
};

class DecisionEngine {

    // ═════════════════════════════════════════════════════════════════
    // LEGALITY & TRICK RESOLUTION (mirrors server.js — unchanged logic)
    // ═════════════════════════════════════════════════════════════════

    /**
     * Return all legal cards from a hand as { card, index } pairs.
     * @param {Array} hand
     * @param {string|null} leadSuit - null when this robo is leading
     * @returns {Array<{card:object, index:number}>}
     */
    static getLegalCards(hand, leadSuit) {
        const withIndex = hand.map((card, index) => ({ card, index }));
        if (!leadSuit) return withIndex;
        const followable = withIndex.filter(c => c.card.suit === leadSuit);
        return followable.length > 0 ? followable : withIndex;
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

    /**
     * Would this card be winning the trick if played right now?
     * NOTE: an empty trick trivially returns true (you're leading, so you're
     * "winning" so far). Callers in ducking situations MUST branch on
     * isLeading rather than relying on this — that conflation was the bug
     * that let Mode B robos lead an Ace.
     */
    static wouldWinTrick(card, trickSoFar, trumpSuit) {
        if (trickSoFar.length === 0) return true;
        const hypothetical = [...trickSoFar, { card }];
        const winner = DecisionEngine.getTrickWinner(hypothetical, trumpSuit);
        return winner === hypothetical[hypothetical.length - 1];
    }

    /** Group a hand by suit, each group sorted highest rank first. */
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

    // ═════════════════════════════════════════════════════════════════
    // DECK ACCOUNTING — the in-play factor
    // ═════════════════════════════════════════════════════════════════

    /**
     * Fraction of the cards I cannot see that are actually in an opponent's
     * hand, as opposed to sitting undealt in the stock.
     *
     * At bid time nothing has been played, so this is simply the share of the
     * unseen deck that got dealt to the other seats.
     *
     * @param {number} handSize
     * @param {number} numPlayers
     * @returns {number} 0..1
     */
    static inPlayFactorAtBid(handSize, numPlayers) {
        const unseen = 52 - handSize;
        if (unseen <= 0) return 1;
        const opponentCards = handSize * Math.max(0, numPlayers - 1);
        return Math.max(0, Math.min(1, opponentCards / unseen));
    }

    /**
     * Same idea mid-round, using what has actually been played.
     * @param {number} myCardsLeft
     * @param {number} opponentCardsLeft
     * @param {number} seenCount - cards played this round + cards in my hand
     * @returns {number} 0..1
     */
    static inPlayFactorLive(opponentCardsLeft, seenCount) {
        const unseen = 52 - seenCount;
        if (unseen <= 0) return 1;
        return Math.max(0, Math.min(1, opponentCardsLeft / unseen));
    }

    /**
     * How many cards rank higher than `rank` within `suit` and are NOT in the
     * supplied known set (my hand, plus optionally cards already played).
     * @param {string} suit
     * @param {string} rank
     * @param {Array} knownCards - cards whose location I know
     * @returns {number} raw count, before the in-play factor is applied
     */
    static rawHigherOutstanding(suit, rank, knownCards) {
        const threshold = RANK_VALUES[rank];
        let higherTotal = 0;
        for (const r of RANKS) if (RANK_VALUES[r] > threshold) higherTotal++;
        let knownHigher = 0;
        for (const c of knownCards) {
            if (c.suit === suit && RANK_VALUES[c.rank] > threshold) knownHigher++;
        }
        return Math.max(0, higherTotal - knownHigher);
    }

    // ═════════════════════════════════════════════════════════════════
    // BID ESTIMATION — per-card win probabilities
    // ═════════════════════════════════════════════════════════════════

    /**
     * Build a per-card win-probability vector for a hand at bid time.
     * This is the heart of the new bidding model (B1–B4).
     *
     * @param {Array} hand
     * @param {string} trumpSuit - may be 'No Trump'
     * @param {number} handSize
     * @param {number} numPlayers
     * @returns {Array<{card:object, p:number}>}
     */
    static cardWinProbabilities(hand, trumpSuit, handSize, numPlayers) {
        const groups = DecisionEngine.groupBySuit(hand);
        const inPlay = DecisionEngine.inPlayFactorAtBid(handSize, numPlayers);
        const opponents = Math.max(1, numPlayers - 1);
        const isNoTrump = trumpSuit === NO_TRUMP;
        const out = [];

        for (const suit of Object.keys(groups)) {
            const cards = groups[suit];
            if (cards.length === 0) continue;
            const isTrump = !isNoTrump && suit === trumpSuit;

            // Expected number of this suit's cards sitting in opponents' hands.
            const opponentSuitCards = (13 - cards.length) * inPlay;

            // How many chances higher cards have to disappear before I need
            // this one. Suit gets led roughly in proportion to its share of
            // the cards in play.
            const foreignLeads = Math.min(2.0, opponentSuitCards / opponents);

            cards.forEach((card, i) => {
                const higherOut = DecisionEngine.rawHigherOutstanding(suit, card.rank, cards) * inPlay;

                // Base: can this card survive, given how many higher cards
                // exist and how many of my own cards sit above it (each of
                // which flushes one higher card out when cashed)?
                const depth = i + 1 + foreignLeads;
                let p = Math.max(0, Math.min(1, 1 - higherOut / depth));

                // Long-suit establishment (B3): once opponents run out of the
                // suit, my remaining low cards win outright — decisive in
                // No Trump, mostly ruffed away in a trump round.
                if (i >= opponentSuitCards) {
                    const establishFactor = isNoTrump
                        ? TUNING.ESTABLISH_NO_TRUMP
                        : TUNING.ESTABLISH_TRUMP_ROUND;
                    p = Math.max(p, TUNING.ESTABLISH_BASE_P * establishFactor);
                }

                // Ruff risk on side-suit winners in a trump round: by the time
                // I cash my k-th winner, opponents may be void and will trump it.
                if (!isTrump && !isNoTrump && p > 0) {
                    const consumed = i * opponents;
                    const remaining = Math.max(0, opponentSuitCards - consumed);
                    const voidLikelihood = Math.max(0, Math.min(1, 1 - remaining / opponents));
                    const ruffProb = voidLikelihood * TUNING.RUFF_TRUMP_HOLD_PROB * TUNING.RUFF_DISCOUNT;
                    p *= (1 - ruffProb);
                }

                out.push({ card, p: Math.max(0, Math.min(1, p)) });
            });
        }

        // Short-suit ruffing power (B4): spare trumps convert voids and
        // singletons into extra tricks. Credited as a bonus spread over the
        // lowest-probability trump cards so it flows into the distribution.
        if (!isNoTrump) {
            const trumpCards = groups[trumpSuit] || [];
            if (trumpCards.length > 0) {
                let ruffPotential = 0;
                for (const suit of SUITS) {
                    if (suit === trumpSuit) continue;
                    const len = (groups[suit] || []).length;
                    if (len === 0)      ruffPotential += TUNING.RUFF_TRICK_VOID;
                    else if (len === 1) ruffPotential += TUNING.RUFF_TRICK_SINGLETON;
                    else if (len === 2 && handSize >= 7) ruffPotential += TUNING.RUFF_TRICK_DOUBLETON;
                }
                // Can't ruff more often than I have trumps that aren't already
                // counted as high-card winners.
                const trumpEntries = out.filter(e => e.card.suit === trumpSuit)
                                        .sort((a, b) => a.p - b.p);
                const alreadyCounted = trumpEntries.reduce((s, e) => s + e.p, 0);
                const spare = Math.max(0, trumpCards.length - alreadyCounted);
                ruffPotential = Math.min(ruffPotential, spare);

                // Distribute onto the weakest trumps first — those are the
                // ones that will actually do the ruffing.
                for (const entry of trumpEntries) {
                    if (ruffPotential <= 0) break;
                    const room = 1 - entry.p;
                    const add = Math.min(room, ruffPotential);
                    entry.p += add;
                    ruffPotential -= add;
                }
            }
        }

        return out;
    }

    /**
     * B7/B12 — shade win probabilities based on what prior bidders claimed.
     *
     * Direction (confirmed as a design decision): a high running bid total is
     * evidence that opponents hold strong hands, so my marginal winners are
     * less likely to survive → shade DOWN. Weighted by bidding position, so
     * the first bidder ignores the signal entirely and the dealer weights it
     * fully. Side-suit cards are shaded harder than trump, since it is aces
     * that get ruffed when opponents are trump-rich.
     *
     * @param {Array<{card:object,p:number}>} probs
     * @param {object} opts - { bidsBefore:number[], handSize, numPlayers, trumpSuit }
     * @returns {Array<{card:object,p:number}>} new array
     */
    static applyBidShading(probs, opts) {
        const { bidsBefore = [], handSize = 0, numPlayers = 4, trumpSuit = null } = opts;
        if (bidsBefore.length === 0 || handSize <= 0) return probs.map(e => ({ ...e }));

        const claimed = bidsBefore.reduce((a, b) => a + b, 0);
        const fairShare = handSize * (bidsBefore.length / Math.max(1, numPlayers));
        if (fairShare <= 0) return probs.map(e => ({ ...e }));

        const excess = (claimed - fairShare) / fairShare;   // >0 means they claimed above par
        const positionWeight = bidsBefore.length / Math.max(1, numPlayers - 1);
        let shade = excess * TUNING.BID_SHADE_PER_EXCESS * positionWeight;
        shade = Math.max(TUNING.BID_SHADE_MIN, Math.min(TUNING.BID_SHADE_MAX, shade));

        return probs.map(e => {
            const isTrump = trumpSuit !== NO_TRUMP && e.card.suit === trumpSuit;
            const factor = isTrump ? (1 - shade * TUNING.BID_SHADE_TRUMP_RATIO) : (1 - shade);
            return { card: e.card, p: Math.max(0, Math.min(1, e.p * factor)) };
        });
    }

    /**
     * Calibrate a per-card probability vector onto real trick counts.
     *
     * Every trick won by me is a trick not won by somebody else, so across the
     * table the expectations must total exactly `handSize`. A model that only
     * looks at my own cards has no way to enforce that and reliably drifts
     * optimistic — it implicitly assumes I always get to play each card at the
     * moment it is most likely to win, which cannot be true for four players
     * at once. Shrinking the total toward handSize/numPlayers restores the
     * constraint while preserving the relative ranking of my cards.
     *
     * @param {Array<{card:object,p:number}>} probs
     * @param {number} handSize
     * @param {number} numPlayers
     * @returns {Array<{card:object,p:number}>} new array
     */
    static shrinkToPrior(probs, handSize, numPlayers) {
        const rawTotal = probs.reduce((s, e) => s + e.p, 0);
        if (rawTotal <= 0) return probs.map(e => ({ ...e }));
        const neutral = handSize / Math.max(1, numPlayers);
        const target = TUNING.BID_CALIB_SLOPE * rawTotal + TUNING.BID_CALIB_OFFSET * neutral;
        const scale = Math.max(0, target) / rawTotal;
        return probs.map(e => ({ card: e.card, p: Math.max(0, Math.min(1, e.p * scale)) }));
    }

    /**
     * Poisson-binomial: exact distribution over "how many of these independent
     * events fire". Cards are not truly independent (winning a trick hands you
     * the lead) but the approximation is good and cheap.
     * @param {number[]} ps
     * @returns {number[]} dist[k] = P(exactly k)
     */
    static trickDistribution(ps) {
        let dist = [1];
        for (const p of ps) {
            const next = new Array(dist.length + 1).fill(0);
            for (let k = 0; k < dist.length; k++) {
                next[k]     += dist[k] * (1 - p);
                next[k + 1] += dist[k] * p;
            }
            dist = next;
        }
        return dist;
    }

    /**
     * B10 — pick the bid maximising expected value under this game's scoring:
     *     hit  → +(10 + bid)
     *     miss → −bid
     * so EV(b) = P(b)·(10 + 2b) − b.
     *
     * Note this correctly makes bid 0 attractive: its miss penalty is zero,
     * so EV(0) = 10·P(0) with no downside at all.
     *
     * @param {number[]} dist
     * @param {number} handSize
     * @param {number|null} forbiddenBid - hook rule (B13)
     * @returns {{bid:number, ev:number, table:Array<{bid:number,p:number,ev:number}>}}
     */
    static bestBidByEV(dist, handSize, forbiddenBid = null) {
        const table = [];
        let best = { bid: 0, ev: -Infinity };
        const caution = handSize <= 2 ? TUNING.SMALL_HAND_CAUTION : 1;

        for (let b = 0; b <= handSize; b++) {
            if (b === forbiddenBid) continue;
            const p = dist[b] || 0;
            let ev = p * (10 + 2 * b) - b;
            if (b > 0) ev *= caution;               // B15 — distrust big claims in tiny hands
            table.push({ bid: b, p, ev });
            if (ev > best.ev) best = { bid: b, ev };
        }
        if (best.ev === -Infinity) best = { bid: forbiddenBid === 0 ? 1 : 0, ev: 0 };
        return { bid: best.bid, ev: best.ev, table };
    }

    // ═════════════════════════════════════════════════════════════════
    // BID ESTIMATORS — the two tier entry points
    // ═════════════════════════════════════════════════════════════════

    /**
     * STANDARD TIER (frozen by design decision — naive, no table awareness).
     * Kept exactly as it was: sum of naive per-card scores, rounded.
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
        const trumpCount = trumpSuit !== NO_TRUMP ? (groups[trumpSuit]?.length || 0) : 0;
        Object.entries(groups).forEach(([suit, cards]) => {
            if (suit === trumpSuit) return;
            score += DecisionEngine.ruffBonus(cards.length, trumpCount);
        });
        return Math.max(0, Math.min(handSize, Math.round(score)));
    }

    /** Naive per-card score — Standard tier only. Retained verbatim. */
    static cardBaseScore(card, isTrump, positionFromTop) {
        if (isTrump) {
            if (card.rank === 'A') return 0.9;
            if (card.rank === 'K') return positionFromTop <= 1 ? 0.8 : 0.5;
            if (card.rank === 'Q' || card.rank === 'J') return positionFromTop <= 1 ? 0.6 : 0.35;
            return positionFromTop === 0 ? 0.4 : 0.25;
        }
        if (positionFromTop === 0 && card.rank === 'A') return 0.7;
        if (positionFromTop === 0 && card.rank === 'K') return 0.45;
        return 0.05;
    }

    /** Short-suit ruff bonus — Standard tier only. Retained verbatim. */
    static ruffBonus(suitCount, trumpCount) {
        if (trumpCount === 0) return 0;
        if (suitCount === 0) return Math.min(0.3, trumpCount * 0.15);
        if (suitCount === 1) return Math.min(0.15, trumpCount * 0.08);
        return 0;
    }

    /**
     * EXPERT TIER bid estimate. Returns the full working, not just a number,
     * so the reasoning trace (M2) can show why.
     *
     * @param {Array} hand
     * @param {string} trumpSuit
     * @param {number} handSize
     * @param {object} context - { numActivePlayers, bidsBefore:number[], forbiddenBid }
     * @returns {{bid:number, probs:Array, dist:number[], expected:number, shade:object, table:Array}}
     */
    static estimateBidExpertDetailed(hand, trumpSuit, handSize, context = {}) {
        const {
            numActivePlayers = 4,
            bidsBefore = [],
            forbiddenBid = null,
        } = context;

        const raw = DecisionEngine.cardWinProbabilities(hand, trumpSuit, handSize, numActivePlayers);
        const shaded = DecisionEngine.applyBidShading(raw, {
            bidsBefore, handSize, numPlayers: numActivePlayers, trumpSuit,
        });
        const calibrated = DecisionEngine.shrinkToPrior(shaded, handSize, numActivePlayers);

        const dist = DecisionEngine.trickDistribution(calibrated.map(e => e.p));
        const expected = calibrated.reduce((s, e) => s + e.p, 0);
        const rawExpected = shaded.reduce((s, e) => s + e.p, 0);
        const { bid, table } = DecisionEngine.bestBidByEV(dist, handSize, forbiddenBid);

        return { bid, probs: calibrated, dist, expected, rawExpected, table };
    }

    /**
     * Backwards-compatible numeric wrapper (used by the older tests).
     * @returns {number}
     */
    static estimateBidExpert(hand, trumpSuit, handSize, context = {}) {
        const bidsBefore = context.bidsBefore || context.bidsSoFar || [];
        return DecisionEngine.estimateBidExpertDetailed(hand, trumpSuit, handSize, {
            ...context, bidsBefore,
        }).bid;
    }

    // ═════════════════════════════════════════════════════════════════
    // BID LEGALITY (hook rule)
    // ═════════════════════════════════════════════════════════════════

    /**
     * The value the last bidder may not bid (would make totals equal handSize).
     * @returns {number|null}
     */
    static getForbiddenBid(bidsSoFarSum, handSize, isLastBidder) {
        if (!isLastBidder) return null;
        const forbidden = handSize - bidsSoFarSum;
        return (forbidden >= 0 && forbidden <= handSize) ? forbidden : null;
    }

    /**
     * B13 — resolve a desired bid against the hook rule.
     *
     * The old version always rounded DOWN, which biased every dealer round
     * downward. Direction is now chosen by the EV table when one is supplied;
     * failing that, by the table's over/under position (shade down when the
     * table has already over-claimed, up when it has under-claimed).
     *
     * @param {number} desiredBid
     * @param {number} handSize
     * @param {number|null} forbiddenBid
     * @param {object} opts - { evTable?, tableSurplusIfBidLow? }
     * @returns {number}
     */
    static resolveLegalBid(desiredBid, handSize, forbiddenBid, opts = {}) {
        let bid = Math.max(0, Math.min(handSize, desiredBid));
        if (forbiddenBid === null || bid !== forbiddenBid) return bid;

        const down = bid - 1;
        const up   = bid + 1;
        const downOk = down >= 0;
        const upOk   = up <= handSize;

        if (!downOk) return up;
        if (!upOk)   return down;

        // Preferred path: whichever neighbour has the better expected value.
        if (Array.isArray(opts.evTable) && opts.evTable.length > 0) {
            const evOf = (b) => {
                const row = opts.evTable.find(r => r.bid === b);
                return row ? row.ev : -Infinity;
            };
            const evDown = evOf(down);
            const evUp   = evOf(up);
            if (evDown !== -Infinity || evUp !== -Infinity) {
                return evUp > evDown ? up : down;
            }
        }

        // Fallback: an over-claimed table means tricks are scarce → go down.
        if (typeof opts.surplusIfBidLow === 'number') {
            return opts.surplusIfBidLow > 0 ? up : down;
        }
        return down;
    }

    // ═════════════════════════════════════════════════════════════════
    // PLAY MODE STATE MACHINE (R14 — Mode D split out)
    // ═════════════════════════════════════════════════════════════════

    /**
     * @returns {'A'|'B'|'C'|'D'}
     *   A = must win every remaining trick
     *   B = bid met exactly; must not win another
     *   C = mixed — win some, duck some
     *   D = bid already unreachable in one direction or the other. The round
     *       score is LOCKED at −bid, so further tricks cost nothing. Switch
     *       to spoiler play rather than continuing to duck pointlessly.
     */
    static getPlayMode(bid, tricksWonSoFar, handSize, tricksPlayedSoFar) {
        const tricksNeeded = bid - tricksWonSoFar;
        const tricksRemaining = handSize - tricksPlayedSoFar;
        if (tricksWonSoFar > bid) return 'D';                 // busted high
        if (tricksNeeded > tricksRemaining) return 'D';       // busted low — can't get there
        if (tricksNeeded <= 0) return 'B';
        if (tricksNeeded >= tricksRemaining) return 'A';
        return 'C';
    }

    // ═════════════════════════════════════════════════════════════════
    // LIVE CARD EVALUATION (play time)
    // ═════════════════════════════════════════════════════════════════

    /**
     * Cards of a suit ranking above `rank` whose location I do not know,
     * scaled by the probability they are actually in an opponent's hand
     * rather than undealt.
     */
    static liveHigherOutstanding(suit, rank, hand, memory, deckInfo) {
        const threshold = RANK_VALUES[rank];
        let higherTotal = 0;
        for (const r of RANKS) if (RANK_VALUES[r] > threshold) higherTotal++;

        let accountedFor = 0;
        for (const c of hand) {
            if (c.suit === suit && RANK_VALUES[c.rank] > threshold) accountedFor++;
        }
        for (const c of (memory.playedCards || [])) {
            if (c.suit === suit && RANK_VALUES[c.rank] > threshold) accountedFor++;
        }
        const unknownHigher = Math.max(0, higherTotal - accountedFor);
        return unknownHigher * (deckInfo?.inPlayFactor ?? 1);
    }

    /** How many trumps are still unaccounted for and plausibly in play (R24). */
    static outstandingTrumps(trumpSuit, hand, memory, deckInfo) {
        if (!trumpSuit || trumpSuit === NO_TRUMP) return 0;
        let accountedFor = 0;
        for (const c of hand) if (c.suit === trumpSuit) accountedFor++;
        for (const c of (memory.playedCards || [])) if (c.suit === trumpSuit) accountedFor++;
        const unknown = Math.max(0, 13 - accountedFor);
        return unknown * (deckInfo?.inPlayFactor ?? 1);
    }

    /**
     * Probability this card wins a trick at some point if I play it when I
     * choose to. Used for R2 (bankable vs conditional) and R18 (trick equity).
     *
     * @returns {number} 0..1
     */
    static liveWinProbability(card, ctx) {
        const { hand, memory, trumpSuit, deckInfo, opponentsRemaining } = ctx;
        const isNoTrump = trumpSuit === NO_TRUMP;
        const isTrump = !isNoTrump && card.suit === trumpSuit;

        const higherOut = DecisionEngine.liveHigherOutstanding(card.suit, card.rank, hand, memory, deckInfo);
        let p = higherOut <= 0.05 ? 1 : Math.max(0, Math.min(1, 1 - higherOut / (1 + higherOut)));

        if (!isTrump && !isNoTrump) {
            // Ruff exposure: only matters if trumps are still out there AND
            // somebody is (or may become) void in this suit.
            const outTrumps = DecisionEngine.outstandingTrumps(trumpSuit, hand, memory, deckInfo);
            if (outTrumps > 0.05) {
                const knownVoids = memory.countKnownVoidPlayers
                    ? memory.countKnownVoidPlayers(card.suit, ctx.myPlayerId)
                    : 0;
                const opp = Math.max(1, opponentsRemaining || 1);
                const voidRisk = Math.min(1, knownVoids / opp + 0.10);
                p *= (1 - voidRisk * TUNING.RUFF_TRUMP_HOLD_PROB);
            }
        }
        return Math.max(0, Math.min(1, p));
    }

    /**
     * Would this card still be winning after every remaining player has acted?
     * (R10 — seat position awareness.) Returns a survival probability.
     */
    static survivalProbability(card, ctx) {
        const { trickSoFar, trumpSuit, playersYetToAct, hand, memory, deckInfo } = ctx;
        if (!DecisionEngine.wouldWinTrick(card, trickSoFar, trumpSuit)) return 0;
        if (!playersYetToAct || playersYetToAct <= 0) return 1;   // I'm last: certain

        const isNoTrump = trumpSuit === NO_TRUMP;
        const leadSuit = trickSoFar.length > 0 ? trickSoFar[0].card.suit : card.suit;
        const isTrump = !isNoTrump && card.suit === trumpSuit;

        // Beaten in-suit?
        let beatRisk = 0;
        if (card.suit === leadSuit || isTrump) {
            const higherOut = DecisionEngine.liveHigherOutstanding(card.suit, card.rank, hand, memory, deckInfo);
            // Chance at least one of the remaining players holds one of them.
            const perPlayer = higherOut / Math.max(1, (deckInfo?.opponentCardsRemaining || 1));
            beatRisk = 1 - Math.pow(1 - Math.min(1, perPlayer), playersYetToAct);
        }

        // Ruffed?
        if (!isTrump && !isNoTrump) {
            const outTrumps = DecisionEngine.outstandingTrumps(trumpSuit, hand, memory, deckInfo);
            if (outTrumps > 0.05) {
                const knownVoids = memory.countKnownVoidPlayers
                    ? memory.countKnownVoidPlayers(leadSuit, ctx.myPlayerId)
                    : 0;
                const ruffRisk = Math.min(0.9, knownVoids * 0.45 + 0.08 * playersYetToAct);
                beatRisk = 1 - (1 - beatRisk) * (1 - ruffRisk);
            }
        }
        return Math.max(0, Math.min(1, 1 - beatRisk));
    }

    /**
     * R9 — trump-aware "cost" of spending a card. The old engine compared raw
     * rank values across suits, so a trump 2 (value 2) looked cheaper than a
     * side-suit Queen (12) and the robo would ruff rather than win in-suit,
     * burning trumps it needed later.
     */
    static cardCost(card, ctx) {
        const { trumpSuit } = ctx;
        const base = RANK_VALUES[card.rank];
        const isTrump = trumpSuit !== NO_TRUMP && card.suit === trumpSuit;
        // A trump is worth roughly a full suit-rank ladder more than a side card.
        return base + (isTrump ? 14 : 0);
    }

    /**
     * Danger: how likely this card is to be FORCED into winning a trick I do
     * not want. This is where the original buffer/exposure insight properly
     * belongs — high cards backed by low cards in the same suit are dodgeable;
     * a bare honour is not.
     */
    static dangerScore(card, ctx) {
        const { hand, trumpSuit, tricksRemaining, memory, deckInfo } = ctx;
        const suitCards = hand.filter(c => c.suit === card.suit);
        const lowerInSuit = suitCards.filter(c => RANK_VALUES[c.rank] < RANK_VALUES[card.rank]).length;

        const higherOut = DecisionEngine.liveHigherOutstanding(card.suit, card.rank, hand, memory, deckInfo);
        const strength = Math.max(0, Math.min(1, 1 - higherOut / 4)); // 1 = nothing beats it

        // Expected remaining leads of this suit ≈ share of remaining cards.
        const opponentSuitCards = Math.max(0, (13 - suitCards.length) * (deckInfo?.inPlayFactor ?? 1)
                                     - (memory.countPlayedInSuit ? memory.countPlayedInSuit(card.suit) : 0));
        const exposure = Math.min(tricksRemaining || 0, opponentSuitCards / Math.max(1, (deckInfo?.opponents || 3)));

        const buffer = lowerInSuit;
        const trapped = Math.max(0, exposure - buffer);

        const isTrump = trumpSuit !== NO_TRUMP && card.suit === trumpSuit;
        // A high trump is dangerous regardless — you can always be forced to
        // follow trump, and if you're void elsewhere you must ruff.
        const trumpPenalty = isTrump ? strength * 0.6 : 0;

        return strength * (0.4 + 0.6 * Math.min(1, trapped)) + trumpPenalty;
    }

    // ═════════════════════════════════════════════════════════════════
    // SITUATION ASSESSMENT — one snapshot per turn
    // ═════════════════════════════════════════════════════════════════

    /**
     * Build the full picture the Expert strategy reasons over. Pure: reads
     * gameState, memory and round context, mutates none of them.
     *
     * @param {object} gs
     * @param {number} playerIndex
     * @param {{memory:object, round:object}} brain
     * @param {object} context - { tricksPlayedSoFar, tricksRemaining, playersYetToAct }
     * @returns {object} situation
     */
    static buildSituation(gs, playerIndex, brain, context) {
        const { memory, round } = brain;
        const me = gs.players[playerIndex];
        const hand = me.hand;
        const trumpSuit = gs.trumpSuit;
        const handSize = gs.numCardsToDeal;
        const trickSoFar = gs.currentTrick || [];
        const isLeading = trickSoFar.length === 0;
        const legal = DecisionEngine.getLegalCards(hand, gs.leadSuit);

        const activePlayers = gs.players.filter(p => p.status === 'Active');
        const numPlayers = activePlayers.length;
        const opponents = Math.max(1, numPlayers - 1);

        const tricksPlayedSoFar = context.tricksPlayedSoFar || 0;
        const tricksRemaining = context.tricksRemaining ?? (handSize - tricksPlayedSoFar);
        const playersYetToAct = context.playersYetToAct ?? Math.max(0, numPlayers - trickSoFar.length - 1);

        // ── Deck accounting ─────────────────────────────────────────
        const playedCount = (memory.playedCards || []).length;
        const seenCount = playedCount + hand.length;
        const opponentCardsRemaining = Math.max(1, opponents * hand.length);
        const inPlayFactor = DecisionEngine.inPlayFactorLive(opponentCardsRemaining, seenCount);
        const deckInfo = { inPlayFactor, opponentCardsRemaining, opponents };

        const evalCtx = {
            hand, memory, trumpSuit, deckInfo, trickSoFar, playersYetToAct,
            tricksRemaining, opponentsRemaining: opponents,
            myPlayerId: me.playerId,
        };

        // ── Mode ────────────────────────────────────────────────────
        const bid = me.bid || 0;
        const tricksWon = me.tricksWon || 0;
        const tricksNeeded = bid - tricksWon;
        const mode = DecisionEngine.getPlayMode(bid, tricksWon, handSize, tricksPlayedSoFar);

        // ── Card evaluation (R2, R18) ───────────────────────────────
        const evaluated = hand.map(card => {
            const p = DecisionEngine.liveWinProbability(card, evalCtx);
            return {
                card,
                p,
                bankable: p >= TUNING.BANKABLE_THRESHOLD,
                danger: DecisionEngine.dangerScore(card, evalCtx),
                cost: DecisionEngine.cardCost(card, evalCtx),
            };
        });

        const bankable = evaluated.filter(e => e.bankable)
                                  .sort((a, b) => b.p - a.p || b.cost - a.cost);
        const conditional = evaluated.filter(e => !e.bankable && e.p > 0.25)
                                     .sort((a, b) => b.p - a.p);

        const expectedRemainingTricks = evaluated.reduce((s, e) => s + e.p, 0);
        const cappedExpected = Math.min(expectedRemainingTricks, tricksRemaining);
        const slack = cappedExpected - Math.max(0, tricksNeeded);

        // ── R3 — surplus demotion ───────────────────────────────────
        // Any bankable winner beyond what I still need is a liability. The
        // STRONGEST surplus card is the priority discard, because it is the
        // one most certain to force a win later.
        const surplusCount = Math.max(0, bankable.length - Math.max(0, tricksNeeded));
        const surplus = bankable.slice(0, surplusCount);

        // ── R19 — proactive bust projection ─────────────────────────
        const projectedOvershoot = bankable.length > Math.max(0, tricksNeeded);

        // ── Table regime (T1) ───────────────────────────────────────
        const tableSurplus = round.biddingComplete ? round.tableSurplus() : 0;
        const regime = tableSurplus > 0 ? 'under' : 'over';

        // Live surplus: tricks left minus what everyone still says they need.
        let outstandingClaims = 0;
        activePlayers.forEach(p => {
            outstandingClaims += Math.max(0, (p.bid || 0) - (p.tricksWon || 0));
        });
        const liveSurplus = tricksRemaining - outstandingClaims;

        // ── Opponent states (S1, S2, S6) ────────────────────────────
        const scores = activePlayers.map(p => p.score || 0);
        const maxScore = Math.max(...scores, 1);
        const minScore = Math.min(...scores, 0);
        const spread = Math.max(1, maxScore - minScore);

        const opponentStates = activePlayers
            .filter(p => p.playerId !== me.playerId)
            .map(p => {
                const oBid = p.bid || 0;
                const oWon = p.tricksWon || 0;
                let state;
                if (oWon > oBid) state = 'busted';
                else if (oWon === oBid) state = 'safe';       // must now duck
                else state = 'chasing';                        // still needs tricks
                // S1 — swing value of busting them, weighted by standing.
                const swing = 10 + 2 * oBid;
                const standing = ((p.score || 0) - minScore) / spread;   // 0..1
                const value = state === 'busted' ? 0 : swing * (0.7 + 0.6 * standing);
                return {
                    playerId: p.playerId, name: p.name,
                    bid: oBid, tricksWon: oWon, state, value,
                    needs: Math.max(0, oBid - oWon),
                };
            })
            .sort((a, b) => b.value - a.value);

        // ── Posture ─────────────────────────────────────────────────
        let posture;
        if (mode === 'D')      posture = 'SABOTAGE';
        else if (mode === 'A') posture = 'GRAB';
        else if (mode === 'B') posture = 'SHED';
        else {
            // Mode C — T5: the table regime modulates the pacing signal.
            const regimeNudge = regime === 'under'
                ? TUNING.REGIME_SLACK_NUDGE      // spare tricks about → expect to overshoot
                : -TUNING.REGIME_SLACK_NUDGE;    // tricks scarce → grab yours
            const effectiveSlack = slack + regimeNudge;
            if (projectedOvershoot && slack > 0) posture = 'SHED';
            else if (effectiveSlack >  TUNING.SLACK_BAND) posture = 'SHED';
            else if (effectiveSlack < -TUNING.SLACK_BAND) posture = 'GRAB';
            else posture = 'BALANCE';
        }

        return {
            me, hand, legal, trickSoFar, isLeading, leadSuit: gs.leadSuit,
            trumpSuit, handSize, numPlayers, opponents, playersYetToAct,
            bid, tricksWon, tricksNeeded, tricksPlayedSoFar, tricksRemaining,
            mode, posture,
            evaluated, bankable, conditional, surplus,
            expectedRemainingTricks: cappedExpected, slack, projectedOvershoot,
            tableSurplus, regime, liveSurplus,
            opponentStates,
            outstandingTrumps: DecisionEngine.outstandingTrumps(trumpSuit, hand, memory, deckInfo),
            deckInfo, evalCtx,
        };
    }

    // ═════════════════════════════════════════════════════════════════
    // CARD SELECTION HELPERS
    // ═════════════════════════════════════════════════════════════════

    static getWinningCards(legalCards, trickSoFar, trumpSuit) {
        return legalCards.filter(c => DecisionEngine.wouldWinTrick(c.card, trickSoFar, trumpSuit));
    }

    static highestCard(cards) {
        if (!cards || cards.length === 0) return null;
        return cards.reduce((best, c) => RANK_VALUES[c.card.rank] > RANK_VALUES[best.card.rank] ? c : best);
    }

    static lowestCard(cards) {
        if (!cards || cards.length === 0) return null;
        return cards.reduce((worst, c) => RANK_VALUES[c.card.rank] < RANK_VALUES[worst.card.rank] ? c : worst);
    }

    /** Cheapest by trump-aware cost rather than raw rank (R9). */
    static cheapestByCost(cards, ctx) {
        if (!cards || cards.length === 0) return null;
        return cards.reduce((best, c) =>
            DecisionEngine.cardCost(c.card, ctx) < DecisionEngine.cardCost(best.card, ctx) ? c : best);
    }

    /** Dearest by trump-aware cost. */
    static dearestByCost(cards, ctx) {
        if (!cards || cards.length === 0) return null;
        return cards.reduce((best, c) =>
            DecisionEngine.cardCost(c.card, ctx) > DecisionEngine.cardCost(best.card, ctx) ? c : best);
    }

    /** Backwards-compatible alias retained for the old tests. */
    static cheapestWinner(winningCards) {
        return DecisionEngine.lowestCard(winningCards);
    }

    /** Who currently wins the trick, as a playerId (null if trick is empty). */
    static currentTrickLeaderId(trickSoFar, trumpSuit) {
        if (!trickSoFar || trickSoFar.length === 0) return null;
        return DecisionEngine.getTrickWinner(trickSoFar, trumpSuit).playerId;
    }
}

module.exports = { DecisionEngine, RANKS, RANK_VALUES, SUITS, NO_TRUMP, TUNING };
