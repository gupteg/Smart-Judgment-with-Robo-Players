# Tests

## test-decision-engine.js
Pure unit tests for the bidding/play heuristics in `server-src/decision-engine.js`.
No server needed. Run with:

```
node tests/test-decision-engine.js
```

Covers: the buffer/exposure nil-bid model (the A,K,Q,2,3,4-single-suit scenario),
hook-rule forbidden-bid computation, the 3-mode play state machine, follow-suit
legality, and trick-winner resolution.

## test-robos.js
End-to-end integration test. Simulates one human player + several robos playing
a full game via a real socket.io connection, checking for hook-rule violations,
illegal plays, and server-side errors along the way.

Requires a running server. Start the server first (ideally with `ROBO_FAST_TEST=1`
so bot think-time delays shrink from seconds to milliseconds, making a full game
finish in seconds instead of minutes), then run the test against it:

```
ROBO_FAST_TEST=1 PORT=5050 node server.js &
node tests/test-robos.js
```

Edit the `URL` constant at the top of the file if you're running the server on a
different port, and the `roboConfigs` array inside `showRoboConfig` to change the
number/difficulty mix of robos being tested.

`ROBO_FAST_TEST=1` should never be set in production — it's a test-only escape
hatch defined in `server.js` that shrinks the tuned bid/play delays
(6000ms/3000ms/1000ms) down to ~10-30ms.
