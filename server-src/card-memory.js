'use strict';

/**
 * CardMemory — tracks what a robo has observed during the CURRENT round only.
 *
 * Unlike UNO (where memory is bounded by a maxCards window and persists
 * across a longer single round), Judgment deals a brand-new hand with a
 * new trump every round, so memory is reset at the start of every round
 * via reset() and holds a full, unbounded record of that round alone.
 *
 * Tracks two things:
 *   1. Every card played this round (by suit/rank/playerId)
 *   2. Every suit each player has revealed themselves void in
 *      (i.e. they failed to follow suit when a suit was led)
 *
 * The Standard tier does not use this at all (its RoboPlayer is built with
 * a no-op memory — see StrategyFactory.createMemory). Only Expert-tier
 * robos read from a real CardMemory instance.
 */
class CardMemory {
    constructor() {
        this.reset();
    }

    /** Clear all tracked state. Called at the start of every round. */
    reset() {
        /** @type {Array<{suit:string, rank:string, playerId:string}>} */
        this.playedCards = [];
        /** @type {Map<string, Set<string>>} playerId -> Set of suits they're void in */
        this.voidSuits = new Map();
    }

    /**
     * Record one card that was just played to the current trick.
     * @param {{suit:string, rank:string}} card
     * @param {string} playerId
     */
    recordCard(card, playerId) {
        this.playedCards.push({ suit: card.suit, rank: card.rank, playerId });
    }

    /**
     * Record that a player revealed they hold no cards of a given suit
     * (they didn't follow suit when required to).
     * @param {string} playerId
     * @param {string} suit
     */
    recordVoid(playerId, suit) {
        if (!this.voidSuits.has(playerId)) this.voidSuits.set(playerId, new Set());
        this.voidSuits.get(playerId).add(suit);
    }

    /**
     * @param {string} playerId
     * @param {string} suit
     * @returns {boolean} true if this player has been observed void in this suit
     */
    isKnownVoid(playerId, suit) {
        return this.voidSuits.get(playerId)?.has(suit) || false;
    }

    /**
     * How many OTHER active players are known void in a given suit.
     * @param {string} suit
     * @param {string} excludePlayerId
     * @returns {number}
     */
    countKnownVoidPlayers(suit, excludePlayerId) {
        let count = 0;
        for (const [pid, suits] of this.voidSuits.entries()) {
            if (pid !== excludePlayerId && suits.has(suit)) count++;
        }
        return count;
    }

    /**
     * How many cards of a given suit have been played so far this round.
     * @param {string} suit
     * @returns {number}
     */
    countPlayedInSuit(suit) {
        return this.playedCards.filter(c => c.suit === suit).length;
    }

    /**
     * Whether a specific card has already been played this round.
     * @param {string} suit
     * @param {string} rank
     * @returns {boolean}
     */
    hasBeenPlayed(suit, rank) {
        return this.playedCards.some(c => c.suit === suit && c.rank === rank);
    }

    /**
     * Total number of tricks completed so far this round (each trick play
     * increments playedCards by numActivePlayers, but this counts distinct
     * plays regardless — callers needing trick count should track that in
     * gameState directly; this is a convenience raw-card-count helper).
     * @returns {number}
     */
    totalCardsPlayed() {
        return this.playedCards.length;
    }
}

/**
 * NoOpCardMemory — used by the Standard tier. Implements the same interface
 * as CardMemory but records nothing and always reports "unknown"/"none",
 * so Standard-tier strategies never accidentally get memory-driven behavior
 * even if they call these methods defensively.
 */
class NoOpCardMemory {
    reset() {}
    recordCard() {}
    recordVoid() {}
    isKnownVoid() { return false; }
    countKnownVoidPlayers() { return 0; }
    countPlayedInSuit() { return 0; }
    hasBeenPlayed() { return false; }
    totalCardsPlayed() { return 0; }
}

module.exports = { CardMemory, NoOpCardMemory };
