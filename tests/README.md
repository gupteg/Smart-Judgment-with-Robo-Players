# Tests

Three harnesses, in increasing order of setup cost.

## 1. `test-decision-engine.js` — unit tests

Pure functions and strategy decisions against hand-built game states. No server,
no sockets, no network. Runs in well under a second.

```bash
node tests/test-decision-engine.js
```

Covers the bidding model (in-play factor, outstanding-higher-cards scoring,
EV-maximising bid selection, shading direction, hook-rule resolution), the play
mode state machine including the new Mode D, trump-aware card cost, and the
specific play rules that were wrong before Phase 1 — safe high discard, never
leading a bankable Ace while shedding, burning the highest card when forced to
win, and ducking rather than cashing a winner the target no longer needs.

Exit code is non-zero if anything fails, so it is safe to wire into CI.

## 2. `calibrate.js` — headless self-play calibration

Deals random rounds and lets the strategies bid and play against each other with
no sockets and no think-time delays, then reports bid-versus-actual calibration
per tier. This is the tool that catches systematic bid bias.

```bash
node tests/calibrate.js [rounds] [numPlayers]
node tests/calibrate.js 1000 4          # default: 400 rounds, 4 players
```

Reports, for each tier: average bid, average tricks won, the bias between them,
the exact-hit rate, overshoot and undershoot rates, and average round score.
Also breaks the Expert tier down by hand size, which is where miscalibration
usually shows up first.

**What good output looks like** (4 players, current tuning):

```
Expert    avg bid 1.26  avg won 1.23   bias -0.03
          exact 50.6%   overshoot 21.2%   undershoot 28.2%
          avg round score 4.79
Standard  avg bid 1.11  avg won 1.52   bias +0.42
          exact 44.6%   overshoot 37.5%   undershoot 17.9%
          avg round score 4.18
```

Two things to watch. **Bias** should sit near zero — a large negative number
means the tier is bidding more than it wins, a large positive one means it is
underbidding. **Average round score** is the bottom line: Expert must beat
Standard, or the extra machinery is not earning its place.

Note this is a diagnostic, not the Phase 3 training harness. It uses a fixed
tuning set and reports; it does not search the parameter space.

Run at least 500 rounds before drawing conclusions — single-game impressions are
exactly what this harness exists to replace.

## 3. `test-robos.js` — end-to-end integration

Drives a full game over real Socket.IO against a running server: one scripted
human plus five robos, mixed tiers. Checks for hook-rule violations, illegal
plays, server errors, and that reasoning traces reach the host.

Needs a server running with fast think-times, in a separate terminal:

```bash
ROBO_FAST_TEST=1 PORT=5066 node server.js
```

then:

```bash
node tests/test-robos.js
```

Exits non-zero if any check fails.

## Environment flags

| Flag | Effect |
|---|---|
| `ROBO_FAST_TEST=1` | Shrinks all robo think-time delays to milliseconds. **Testing only** — never set in production. Also turns telemetry on. |
| `ROBO_TELEMETRY=1` | Prints one `[RoboStat]` line per robo per round: bid, tricks won, delta, hit/overshot/short, score. Off by default. |
| `ROBO_TRACE=0` | Disables the host-only reasoning panel feed. On by default. |

### Reading telemetry

```
[RoboStat] round=3 cards=6 trump=Diamonds tier=Expert name=Bot-Exp-1 bid=2 won=1 delta=-1 result=SHORT score=-2
```

`delta` is `won - bid`. `SHORT` means the robo won fewer tricks than it bid;
`OVERSHOT` means more. To check for bias across a session:

```bash
ROBO_TELEMETRY=1 node server.js | grep RoboStat | grep Expert
```

On Render these appear in the dashboard Logs tab. The filesystem there is
ephemeral, so copy anything worth keeping before it rolls off — that is why
telemetry goes to the console rather than a file.
