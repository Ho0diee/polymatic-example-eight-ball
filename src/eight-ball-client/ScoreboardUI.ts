import { Memo, Middleware } from "polymatic";

import { Color, type BilliardContext } from "../eight-ball/BilliardContext";
import { isMyTurn, type ClientBilliardContext } from "./ClientContext";

/**
 * Updates the scoreboard UI: ball indicators, score, time, turn indicator
 */
export class ScoreboardUI extends Middleware<ClientBilliardContext> {
  player1Balls: HTMLElement;
  player2Balls: HTMLElement;
  scoreElement: HTMLElement;
  timeElement: HTMLElement;
  multiplierElement: HTMLElement;
  turnIndicators: NodeListOf<Element>;

  startTime: number = 0;
  score: number = 0;
  multiplier: number = 1;
  
  memo = Memo.init();

  constructor() {
    super();
    this.on("activate", this.handleActivate);
    this.on("deactivate", this.handleDeactivate);
    this.on("frame-loop", this.handleFrameLoop);
    this.on("shot-end", this.handleShotEnd);
  }

  handleActivate() {
    this.player1Balls = document.getElementById("player1-balls");
    this.player2Balls = document.getElementById("player2-balls");
    this.scoreElement = document.querySelector(".stat-box.score");
    this.timeElement = document.querySelector(".stat-box.time");
    this.multiplierElement = document.querySelector(".stat-box.multiplier");
    this.turnIndicators = document.querySelectorAll(".turn-indicator");
    
    this.startTime = Date.now();
    this.score = 0;
    this.multiplier = 1;
  }

  handleDeactivate() {
    this.memo.clear();
  }

  handleShotEnd(data: { pocketed: any[] }) {
    if (data.pocketed && data.pocketed.length > 0) {
      // Add score for each ball pocketed
      const points = data.pocketed.length * 100 * this.multiplier;
      this.score += points;
      
      // Increase multiplier on successful pocket
      this.multiplier = Math.min(this.multiplier + 1, 10);
    } else {
      // Reset multiplier on miss
      this.multiplier = 1;
    }
    
    this.updateMultiplier();
    this.updateScore();
  }

  handleFrameLoop = () => {
    this.updateTime();
    this.updateBallIndicators();
    this.updateTurnIndicator();
  };

  updateTime() {
    if (!this.timeElement) return;
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    this.timeElement.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  updateScore() {
    if (!this.scoreElement) return;
    this.scoreElement.textContent = String(this.score);
  }

  updateMultiplier() {
    if (!this.multiplierElement) return;
    this.multiplierElement.textContent = `x${this.multiplier}`;
  }

  updateBallIndicators() {
    if (!this.player1Balls || !this.player2Balls || !this.context.balls) return;

    // Count remaining balls by type
    let solidsRemaining = 0;
    let stripesRemaining = 0;

    for (const ball of this.context.balls) {
      if (Color.is(ball.color, 'solid') && ball.color !== 'white' && ball.color !== 'black') {
        solidsRemaining++;
      } else if (Color.is(ball.color, 'stripe')) {
        stripesRemaining++;
      }
    }

    // Update player 1 balls (solids)
    const p1Slots = this.player1Balls.querySelectorAll('.ball-slot');
    const solidsPocketed = 7 - solidsRemaining;
    p1Slots.forEach((slot, i) => {
      slot.classList.remove('pocketed', 'filled');
      if (i < solidsPocketed) {
        slot.classList.add('pocketed');
      } else if (i < 7) {
        slot.classList.add('filled');
      }
    });

    // Update player 2 balls (stripes)
    const p2Slots = this.player2Balls.querySelectorAll('.ball-slot');
    const stripesPocketed = 7 - stripesRemaining;
    p2Slots.forEach((slot, i) => {
      slot.classList.remove('pocketed', 'filled');
      if (i < stripesPocketed) {
        slot.classList.add('pocketed');
      } else if (i < 7) {
        slot.classList.add('filled');
      }
    });
  }

  updateTurnIndicator() {
    if (!this.turnIndicators) return;
    
    const myTurn = isMyTurn(this.context);
    
    this.turnIndicators.forEach((indicator, i) => {
      indicator.classList.remove('active');
      if (i === 0 && myTurn) {
        indicator.classList.add('active');
      } else if (i === 1 && !myTurn && this.context.gameStarted && !this.context.shotInProgress) {
        indicator.classList.add('active');
      }
    });
  }
}
