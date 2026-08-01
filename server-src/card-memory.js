'use strict';

/**
 * CardMemory — what a robo has observed during the CURRENT round only.
 *
 * Judgment deals a brand-new hand with a new trump every round, so memory is
 * reset at the start of every round via reset() and holds a full, unbounded
 * record of that round alone.
 *
 * Tracks:
 *   1. Every card played this round (suit/rank/playerId)
 *   2. Every suit each player has revealed themselves void in
 *
 * The Standard tier is built with NoOpCardMemory, so it never gains any of
 * this even if its strategy defensively calls these methods.
 *
 * PHASE 1: added highestPlayedInSuit() and countPlayedAbove(), used by the
 * decision engine's live card evaluation.
 */

const RANK_VALUES = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };

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

    recordCard(card, playerId) {
        this.playedCards.push({ suit: card.suit, rank: card.rank, playerId });
    }

    recordVoid(playerId, suit) {
        if (!this.voidSuits.has(playerId)) this.voidSuits.set(playerId, new Set());
        this.voidSuits.get(playerId).add(suit);
    }

    isKnownVoid(playerId, suit) {
        return this.voidSuits.get(playerId)?.has(suit) || false;
    }

    /** How many OTHER players are known void in a given suit. */
    countKnownVoidPlayers(suit, excludePlayerId) {
        let count = 0;
        for (const [pid, suits] of this.voidSuits.entries()) {
            if (pid !== excludePlayerId && suits.has(suit)) count++;
        }
        return count;
    }

    /** How many cards of a given suit have been played this round. */
    countPlayedInSuit(suit) {
        return this.playedCards.filter(c => c.suit === suit).length;
    }

    /** How many cards of a suit ranking above `rank` have already been played. */
    countPlayedAbove(suit, rank) {
        const threshold = RANK_VALUES[rank];
        return this.playedCards.filter(c => c.suit === suit && RANK_VALUES[c.rank] > threshold).length;
    }

    /** Highest rank value seen in a suit this round, or 0 if none. */
    highestPlayedInSuit(suit) {
        let best = 0;
        for (const c of this.playedCards) {
            if (c.suit === suit && RANK_VALUES[c.rank] > best) best = RANK_VALUES[c.rank];
        }
        return best;
    }

    hasBeenPlayed(suit, rank) {
        return this.playedCards.some(c => c.suit === suit && c.rank === rank);
    }

    totalCardsPlayed() {
        return this.playedCards.length;
    }
}

/**
 * NoOpCardMemory — the Standard tier's stand-in. Same interface, records
 * nothing, always reports "unknown"/"none".
 */
class NoOpCardMemory {
    constructor() {
        this.playedCards = [];
        this.voidSuits = new Map();
    }
    reset() {}
    recordCard() {}
    recordVoid() {}
    isKnownVoid() { return false; }
    countKnownVoidPlayers() { return 0; }
    countPlayedInSuit() { return 0; }
    countPlayedAbove() { return 0; }
    highestPlayedInSuit() { return 0; }
    hasBeenPlayed() { return false; }
    totalCardsPlayed() { return 0; }
}

module.exports = { CardMemory, NoOpCardMemory };
