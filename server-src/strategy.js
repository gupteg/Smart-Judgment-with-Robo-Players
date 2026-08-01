'use strict';

/**
 * Strategy — async interface for robo bidding and card-play decisions.
 *
 * Two difficulty tiers only (per design decision):
 *   StandardStrategy — naive bid estimator, this-trick-only awareness, no
 *                       cross-trick memory.
 *   ExpertStrategy    — buffer/exposure-aware bid estimator, full-round
 *                        CardMemory, cheapest-sufficient-winner play,
 *                        lowest-danger-suit discards.
 *
 * Both expose two methods:
 *   async selectBid(gs, playerIndex, memory, context)  -> integer bid
 *   async selectCard(gs, playerIndex, memory, context) -> {suit, rank} card
 *
 * `gs` is the raw, read-only gameState broadcast to clients.
 * `context` is a small computed-fields object server.js builds fresh before
 * each call (see server.js buildBidContext / buildPlayContext), containing
 * whatever derived info the strategy needs that isn't cheap to recompute
 * from gs alone (e.g. whether this robo is the last bidder this round).
 * Keeping this separate from gs means gs never needs private fields bolted
 * onto it, and these engines stay testable with plain hand-built objects.
 *
 * The async signature future-proofs the interface the same way the UNO
 * bot architecture does, in case a future tier calls out to a remote model.
 */

const { DecisionEngine, RANK_VALUES } = require('./decision-engine');

// ─────────────────────────────────────────────────────────────────────────
// BASE CLASS
// ─────────────────────────────────────────────────────────────────────────

class Strategy {
    /** @returns {Promise<number>} */
    async selectBid(gs, playerIndex, memory, context) {
        throw new Error(`${this.constructor.name}.selectBid() not implemented`);
    }

    /** @returns {Promise<{suit:string, rank:string}>} */
    async selectCard(gs, playerIndex, memory, context) {
        throw new Error(`${this.constructor.name}.selectCard() not implemented`);
    }

    /** Shared: sum of bids placed so far this round (nulls treated as 0). */
    _bidsSoFarSum(gs) {
        return gs.players.reduce((sum, p) => sum + (p.bid || 0), 0);
    }

    /** Shared: array of individual bids placed so far (excluding nulls). */
    _bidsSoFarArray(gs) {
        return gs.players.filter(p => p.bid !== null && p.bid !== undefined).map(p => p.bid);
    }

    /** Shared: count of active players. */
    _numActivePlayers(gs) {
        return gs.players.filter(p => p.status === 'Active').length;
    }
}

// ─────────────────────────────────────────────────────────────────────────
// STANDARD
// ─────────────────────────────────────────────────────────────────────────

class StandardStrategy extends Strategy {
    async selectBid(gs, playerIndex, memory, context) {
        const player = gs.players[playerIndex];
        const handSize = gs.numCardsToDeal;
        const raw = DecisionEngine.estimateBidStandard(player.hand, gs.trumpSuit, handSize);

        const forbidden = DecisionEngine.getForbiddenBid(
            this._bidsSoFarSum(gs), handSize, context.isLastBidder
        );
        return DecisionEngine.resolveLegalBid(raw, handSize, forbidden);
    }

    async selectCard(gs, playerIndex, memory, context) {
        const player = gs.players[playerIndex];
        const legal = DecisionEngine.getLegalCards(player.hand, gs.leadSuit);
        if (legal.length === 1) return legal[0].card;

        const mode = DecisionEngine.getPlayMode(
            player.bid, player.tricksWon, gs.numCardsToDeal, context.tricksPlayedSoFar
        );
        const trickSoFar = gs.currentTrick;
        const winningCards = DecisionEngine.getWinningCards(legal, trickSoFar, gs.trumpSuit);
        const nonWinning = legal.filter(c => !winningCards.includes(c));

        if (mode === 'A') {
            // Must win: play the strongest winning card available (Standard
            // doesn't bother conserving high cards — that's an Expert trait).
            const best = DecisionEngine.highestCard(winningCards);
            return (best || DecisionEngine.highestCard(legal)).card;
        }

        if (mode === 'B') {
            // Must avoid winning: duck with the lowest safe card; if forced
            // to win, take it with the lowest winning card.
            if (nonWinning.length > 0) return DecisionEngine.lowestCard(nonWinning).card;
            return DecisionEngine.lowestCard(winningCards).card;
        }

        // Mode C — mixed.
        if (trickSoFar.length === 0) {
            // Leading: play a "medium" card — simple heuristic, no suit strategy.
            const sorted = [...legal].sort((a, b) => RANK_VALUES[a.card.rank] - RANK_VALUES[b.card.rank]);
            return sorted[Math.floor(sorted.length / 2)].card;
        }
        // Following: win cheaply if we still need the trick, else duck.
        if (winningCards.length > 0) return DecisionEngine.lowestCard(winningCards).card;
        return DecisionEngine.lowestCard(nonWinning.length > 0 ? nonWinning : legal).card;
    }
}

// ─────────────────────────────────────────────────────────────────────────
// EXPERT
// ─────────────────────────────────────────────────────────────────────────

class ExpertStrategy extends Strategy {
    async selectBid(gs, playerIndex, memory, context) {
        const player = gs.players[playerIndex];
        const handSize = gs.numCardsToDeal;
        const raw = DecisionEngine.estimateBidExpert(player.hand, gs.trumpSuit, handSize, {
            numActivePlayers: this._numActivePlayers(gs),
            bidsSoFar: this._bidsSoFarArray(gs),
        });

        const forbidden = DecisionEngine.getForbiddenBid(
            this._bidsSoFarSum(gs), handSize, context.isLastBidder
        );
        return DecisionEngine.resolveLegalBid(raw, handSize, forbidden);
    }

    async selectCard(gs, playerIndex, memory, context) {
        const player = gs.players[playerIndex];
        const legal = DecisionEngine.getLegalCards(player.hand, gs.leadSuit);
        if (legal.length === 1) return legal[0].card;

        const mode = DecisionEngine.getPlayMode(
            player.bid, player.tricksWon, gs.numCardsToDeal, context.tricksPlayedSoFar
        );
        const trickSoFar = gs.currentTrick;
        const winningCards = DecisionEngine.getWinningCards(legal, trickSoFar, gs.trumpSuit);
        const nonWinning = legal.filter(c => !winningCards.includes(c));

        if (mode === 'A') {
            // Must win: play the cheapest sufficient winner, conserving
            // stronger cards for later tricks.
            const winner = DecisionEngine.cheapestWinner(winningCards);
            return (winner || DecisionEngine.highestCard(legal)).card;
        }

        if (mode === 'B') {
            // Must avoid winning: discard from the lowest-danger suit first.
            const pool = nonWinning.length > 0 ? nonWinning : winningCards;
            const best = this._lowestDangerDiscard(pool, player.hand, player.playerId, gs, memory, context);
            return best.card;
        }

        // Mode C — mixed.
        if (trickSoFar.length === 0) {
            return this._chooseLead(legal, player.hand, gs).card;
        }
        if (winningCards.length > 0) {
            return DecisionEngine.cheapestWinner(winningCards).card;
        }
        const best = this._lowestDangerDiscard(
            nonWinning.length > 0 ? nonWinning : legal, player.hand, player.playerId, gs, memory, context
        );
        return best.card;
    }

    /**
     * Pick the discard whose suit currently has the lowest live danger:
     * remaining low-card buffer in hand, vs. remaining likely exposure
     * (adjusted down for opponents already revealed void in that suit).
     */
    _lowestDangerDiscard(candidates, hand, selfPlayerId, gs, memory, context) {
        if (candidates.length === 1) return candidates[0];
        const groups = DecisionEngine.groupBySuit(hand);
        let best = candidates[0];
        let bestDanger = Infinity;
        for (const c of candidates) {
            const suitCards = groups[c.card.suit] || [];
            const buffer = Math.max(0, suitCards.length - 1);
            const numActive = this._numActivePlayers(gs);
            const knownVoid = memory.countKnownVoidPlayers(c.card.suit, selfPlayerId);
            const remainingExposurePrior = DecisionEngine.estimateExposurePrior(context.tricksRemaining, numActive);
            const exposure = Math.max(0, remainingExposurePrior - knownVoid);
            const danger = Math.max(0, exposure - buffer);
            if (danger < bestDanger) { bestDanger = danger; best = c; }
        }
        return best;
    }

    /**
     * Choose a lead card in Mode C: prefer a suit with a moderate,
     * controllable winner (not the strongest trump — save that), banking
     * one trick at a time without overcommitting.
     */
    _chooseLead(legal, hand, gs) {
        const groups = DecisionEngine.groupBySuit(hand);
        // Prefer a non-trump suit where we hold a mid-strength top card
        // (K or Q) with at least one low card behind it — controllable.
        const candidates = legal.filter(c => {
            const suitCards = groups[c.card.suit] || [];
            const isTop = suitCards[0] && suitCards[0].rank === c.card.rank;
            return isTop && suitCards.length >= 2 && c.card.suit !== gs.trumpSuit &&
                (c.card.rank === 'K' || c.card.rank === 'Q');
        });
        if (candidates.length > 0) return candidates[0];
        // Fallback: same medium-card heuristic as Standard.
        const sorted = [...legal].sort((a, b) => RANK_VALUES[a.card.rank] - RANK_VALUES[b.card.rank]);
        return sorted[Math.floor(sorted.length / 2)];
    }
}

// ─────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────

class StrategyFactory {
    /**
     * @param {string} difficulty - 'Standard'|'Expert' (also accepts legacy
     *                               internal names 'Normal'|'Master')
     * @returns {Strategy}
     */
    static create(difficulty) {
        switch (difficulty) {
            case 'Standard':
            case 'Normal':
                return new StandardStrategy();
            case 'Expert':
            case 'Master':
                return new ExpertStrategy();
            default:
                console.warn(`[Robo] Unknown difficulty '${difficulty}', defaulting to Standard`);
                return new StandardStrategy();
        }
    }

    /**
     * @param {string} difficulty
     * @returns {object} CardMemory or NoOpCardMemory instance
     */
    static createMemory(difficulty) {
        const { CardMemory, NoOpCardMemory } = require('./card-memory');
        switch (difficulty) {
            case 'Expert':
            case 'Master':
                return new CardMemory();
            default:
                return new NoOpCardMemory();
        }
    }
}

module.exports = { Strategy, StandardStrategy, ExpertStrategy, StrategyFactory };
