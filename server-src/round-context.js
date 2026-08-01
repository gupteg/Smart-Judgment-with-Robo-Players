'use strict';

/**
 * RoundContext — per-robo, per-round record of OBSERVED FACTS.
 *
 * Design contract (Phase 1):
 *   - This class stores facts only. It performs no strategic reasoning.
 *   - Every derived value (table surplus is the one trivial exception,
 *     since it is pure arithmetic on the bid ledger) is computed fresh
 *     each turn by pure functions in decision-engine.js.
 *   - Nothing here is cached across turns, so there is no staleness bug
 *     class to worry about.
 *
 * Together with CardMemory this forms the robo's `brain`:
 *     brain = { memory: CardMemory, round: RoundContext }
 * which is what gets passed into Strategy methods. Phase 2 will add
 * `brain.opponents` (the inference layer) without changing any signature.
 *
 * Reset every round via RoboPlayer.resetRound(), exactly like CardMemory.
 */
class RoundContext {
    constructor(myPlayerId = null) {
        this.myPlayerId = myPlayerId;
        this.reset();
    }

    /**
     * Clear everything and (optionally) seed this round's deal facts.
     * @param {object} deal - { handSize, trumpSuit, playerOrder:string[], dealerId }
     */
    reset(deal = {}) {
        // ── Deal facts ──────────────────────────────────────────────
        this.handSize    = deal.handSize    || 0;
        this.trumpSuit   = deal.trumpSuit   || null;
        this.playerOrder = deal.playerOrder || [];   // active playerIds, seat order
        this.dealerId    = deal.dealerId    || null;

        // ── Bid ledger (T1, B11, B12) ───────────────────────────────
        /** @type {Map<string, number>} playerId -> bid */
        this.bids = new Map();
        /** @type {Array<{playerId:string, bid:number}>} in bidding order */
        this.bidSequence = [];
        this.biddingComplete = false;

        // ── Trick ledger (R18, R19, opponent state) ─────────────────
        /** @type {Array<string>} playerId of each trick's winner, in order */
        this.trickWinners = [];
    }

    /** Seed deal facts without wiping anything already recorded. */
    seed(deal = {}) {
        if (deal.handSize    !== undefined) this.handSize    = deal.handSize;
        if (deal.trumpSuit   !== undefined) this.trumpSuit   = deal.trumpSuit;
        if (deal.playerOrder !== undefined) this.playerOrder = deal.playerOrder;
        if (deal.dealerId    !== undefined) this.dealerId    = deal.dealerId;
    }

    // ─────────────────────────────────────────────────────────────────
    // RECORDING
    // ─────────────────────────────────────────────────────────────────

    /**
     * Record a bid as it is placed. Called for EVERY player (human and
     * robo alike) so the robo sees bidding ORDER, not just the final
     * table — B11 weights the residual-tricks signal by how late we bid.
     */
    recordBid(playerId, bid) {
        if (this.bids.has(playerId)) return; // idempotent guard
        this.bids.set(playerId, bid);
        this.bidSequence.push({ playerId, bid });
    }

    /** Called once when the last bid lands and play is about to begin. */
    markBiddingComplete() {
        this.biddingComplete = true;
    }

    /** Record who won a completed trick. */
    recordTrickWinner(playerId) {
        if (playerId) this.trickWinners.push(playerId);
    }

    // ─────────────────────────────────────────────────────────────────
    // TRIVIAL ARITHMETIC ON THE LEDGER
    // (Anything requiring judgement lives in decision-engine.js.)
    // ─────────────────────────────────────────────────────────────────

    /** Sum of every bid recorded so far this round. */
    bidsSum() {
        let sum = 0;
        for (const b of this.bids.values()) sum += b;
        return sum;
    }

    /** How many players have bid so far. */
    bidsPlacedCount() {
        return this.bidSequence.length;
    }

    /** Bids placed strictly before me, in order. */
    bidsBeforeMe() {
        const idx = this.bidSequence.findIndex(e => e.playerId === this.myPlayerId);
        const upto = idx === -1 ? this.bidSequence.length : idx;
        return this.bidSequence.slice(0, upto).map(e => e.bid);
    }

    /**
     * T1 — the table's structural surplus for the round.
     *   surplus > 0  → UNDERBID table: spare tricks exist and somebody
     *                  must eat them. Duck early, don't be that player.
     *   surplus < 0  → OVERBID table: tricks are scarcer than claimed.
     *                  Grab yours early.
     * The hook rule guarantees this is never exactly 0 once bidding
     * completes, so every round has a definite regime.
     * @returns {number}
     */
    tableSurplus() {
        return this.handSize - this.bidsSum();
    }

    /** @returns {'under'|'over'} — only meaningful once bidding completes. */
    regime() {
        return this.tableSurplus() > 0 ? 'under' : 'over';
    }

    /** How many tricks this robo has won this round (from the trick ledger). */
    myTricksWon() {
        return this.trickWinners.filter(id => id === this.myPlayerId).length;
    }

    /** Tricks completed so far this round. */
    tricksPlayed() {
        return this.trickWinners.length;
    }
}

/**
 * NoOpRoundContext — the Standard tier's stand-in. Implements the same
 * interface, records nothing, and reports neutral values. Standard-tier
 * strategy must never gain table-regime awareness even if it defensively
 * calls these methods.
 */
class NoOpRoundContext {
    constructor() {
        this.myPlayerId = null;
        this.handSize = 0;
        this.trumpSuit = null;
        this.playerOrder = [];
        this.dealerId = null;
        this.bids = new Map();
        this.bidSequence = [];
        this.biddingComplete = false;
        this.trickWinners = [];
    }
    reset() {}
    seed() {}
    recordBid() {}
    markBiddingComplete() {}
    recordTrickWinner() {}
    bidsSum() { return 0; }
    bidsPlacedCount() { return 0; }
    bidsBeforeMe() { return []; }
    tableSurplus() { return 0; }
    regime() { return 'under'; }
    myTricksWon() { return 0; }
    tricksPlayed() { return 0; }
}

module.exports = { RoundContext, NoOpRoundContext };
