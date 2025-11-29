import { Middleware } from "polymatic";

import { Color, Ball, type BilliardContext } from "./BilliardContext";

/**
 * 2-player eight-ball rules and gameplay.
 */
export class EightBall2P extends Middleware<BilliardContext> {
  constructor() {
    super();
    this.on("activate", this.handleActivate);
    this.on("game-start", this.handleGameStart);
    this.on("ball-pocketed", this.handleBallPocketed);
    this.on("shot-end", this.handleShotEnd);
  }

  handleActivate() {
    this.emit("init-table");
    this.emit("rack-balls");
  }

  handleGameStart() {
    this.emit("init-cue-ball");
    // Don't assign colors at start - they get assigned when first ball is pocketed
  }

  handleBallPocketed = (data: { ball: Ball }) => {
    const ball = data.ball;
    
    // Skip cue ball and 8 ball for color assignment
    if (ball.color === Color.white || ball.color === Color.black) return;
    
    // Check if colors already assigned
    const colorsAssigned = this.context.players[0]?.color || this.context.players[1]?.color;
    if (colorsAssigned) return;
    
    // Find current player
    const player = this.context.players.find((p) => p.turn === this.context.turn.current);
    if (!player) return;
    
    // Assign color based on what was pocketed
    const isSolid = Color.is(ball.color, Color.solid);
    player.color = isSolid ? Color.solid : Color.stripe;
    
    // Assign opposite to other player
    const otherPlayer = this.context.players.find(p => p.id !== player.id);
    if (otherPlayer) {
      otherPlayer.color = isSolid ? Color.stripe : Color.solid;
    }
    
    this.emit("update");
  };

  handleShotEnd = (data: { pocketed: Ball[] }) => {
    const player = this.context.players.find((player) => player.turn === this.context.turn.current);
    const otherPlayer = this.context.players.find((p) => p.id !== player?.id);

    const hasCueBall = data.pocketed.some((ball) => Color.is(ball.color, Color.white));
    const hasEightBall = data.pocketed.some((ball) => Color.is(ball.color, Color.black));
    const hasOwnBall = data.pocketed.some((ball) => Color.is(ball.color, player?.color));
    const hasOpponentBall = data.pocketed.some((ball) => Color.is(ball.color, otherPlayer?.color));

    if (hasEightBall) {
      // Check if player has cleared all their balls (8 ball should be pocketed last)
      const ownBallLeft = this.context.balls.some((ball) => Color.is(ball.color, player?.color));
      const playerWin = !ownBallLeft && !hasCueBall; // Must have no balls left AND not scratch
      const winner = playerWin ? player : otherPlayer;
      this.context.gameOver = true;
      this.context.winner = winner?.id;
      this.emit("game-over", { winner, loser: playerWin ? otherPlayer : player, reason: playerWin ? 'legal-8ball' : 'early-8ball' });
    } else if (hasCueBall) {
      // Foul! Emit foul event for UI, pass turn, then ball in hand
      this.emit("foul");
      this.emit("pass-turn");
      this.context.foulCommitted = true;
      this.context.ballInHand = true;
      setTimeout(() => this.emit("ball-in-hand"), 400);
    } else if (hasOpponentBall) {
      // Pocketed opponent's ball (even if also pocketed own) - pass turn
      this.emit("pass-turn");
    } else if (hasOwnBall) {
      // Only pocketed own ball(s) - keep turn
    } else {
      // Didn't pocket anything - pass turn
      this.emit("pass-turn");
    }
    this.emit("update");
  };
}
