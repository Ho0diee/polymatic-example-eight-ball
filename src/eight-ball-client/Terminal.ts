import { Dataset, Driver, Memo, Middleware } from "polymatic";

import { CueStick, Ball, Pocket, Rail, Table, type BilliardContext } from "../eight-ball/BilliardContext";

const SVG_NS = "http://www.w3.org/2000/svg";

const STROKE_WIDTH = 0.006 / 2;

// Quaternion helper
class Quaternion {
  w: number;
  x: number;
  y: number;
  z: number;

  constructor(w: number = 1, x: number = 0, y: number = 0, z: number = 0) {
    this.w = w;
    this.x = x;
    this.y = y;
    this.z = z;
  }

  static fromAxisAngle(axis: { x: number; y: number; z: number }, angle: number) {
    const halfAngle = angle / 2;
    const s = Math.sin(halfAngle);
    return new Quaternion(Math.cos(halfAngle), axis.x * s, axis.y * s, axis.z * s);
  }

  multiply(q: Quaternion) {
    const w = this.w * q.w - this.x * q.x - this.y * q.y - this.z * q.z;
    const x = this.w * q.x + this.x * q.w + this.y * q.z - this.z * q.y;
    const y = this.w * q.y - this.x * q.z + this.y * q.w + this.z * q.x;
    const z = this.w * q.z + this.x * q.y - this.y * q.x + this.z * q.w;
    return new Quaternion(w, x, y, z);
  }

  normalize() {
    const len = Math.sqrt(this.w * this.w + this.x * this.x + this.y * this.y + this.z * this.z);
    if (len === 0) return this;
    this.w /= len;
    this.x /= len;
    this.y /= len;
    this.z /= len;
    return this;
  }

  conjugate() {
    return new Quaternion(this.w, -this.x, -this.y, -this.z);
  }

  rotateVector(v: { x: number; y: number; z: number }) {
    // p' = q * p * q^-1
    const qv = new Quaternion(0, v.x, v.y, v.z);
    const qInv = this.conjugate();
    const qResult = this.multiply(qv).multiply(qInv);
    return { x: qResult.x, y: qResult.y, z: qResult.z };
  }
}

/**
 * Implements rendering and collecting user-input
 */
export class Terminal extends Middleware<BilliardContext> {
  container: SVGGElement;

  scorecardGroup: SVGGElement;
  ballsGroup: SVGGElement;
  tableGroup: SVGGElement;
  cueGroup: SVGGElement;
  frameGroup: SVGGElement;

  constructor() {
    super();
    this.on("activate", this.handleActivate);
    this.on("deactivate", this.handleDeactivate);
    this.on("frame-loop", this.handleFrameLoop);
    this.on("main-start", this.handleStart);

    this.dataset.addDriver(this.tableDriver);
    this.dataset.addDriver(this.railDriver);
    this.dataset.addDriver(this.pocketDriver);

    this.dataset.addDriver(this.ballDriver);

    this.dataset.addDriver(this.cueDriver);

    this.scorecardGroup = document.createElementNS(SVG_NS, "g");
    this.ballsGroup = document.createElementNS(SVG_NS, "g");
    this.tableGroup = document.createElementNS(SVG_NS, "g");
    this.cueGroup = document.createElementNS(SVG_NS, "g");
    this.frameGroup = document.createElementNS(SVG_NS, "g");

    this.container = document.createElementNS(SVG_NS, "g");
    this.container.classList.add("billiards");

    // Order matters for z-index
    this.container.appendChild(this.frameGroup); // outer wood frame behind everything
    this.container.appendChild(this.tableGroup);
    this.container.appendChild(this.ballsGroup);
    this.container.appendChild(this.cueGroup); // Cue on top of balls
    this.container.appendChild(this.scorecardGroup);
  }

  handleActivate() {
    const svg = document.getElementById("polymatic-eight-ball");
    if (svg && svg instanceof SVGSVGElement) {
      // Add gradient definitions
      this.addSvgDefs(svg);
      
      svg.appendChild(this.container);
      this.container.parentElement?.addEventListener("pointerdown", this.handlePointerDown);
      this.container.parentElement?.addEventListener("pointermove", this.handlePointerMove);
      this.container.parentElement?.addEventListener("pointerup", this.handlePointerUp);
      
      this.setupPowerControl();

      window.addEventListener("resize", this.handleWindowResize);
      window.addEventListener("orientationchange", this.handleWindowResize);
      this.handleWindowResize();
    } else {
      console.error("Container SVG element not found");
    }
  }

  powerCleanup?: () => void;

  setupPowerControl() {
    const container = document.querySelector('.power-bar-container') as HTMLElement;
    const indicator = document.querySelector('.power-indicator') as HTMLElement;
    if (!container || !indicator) return;

    const updatePower = (clientY: number) => {
      const rect = container.getBoundingClientRect();
      const height = rect.height;
      const bottom = rect.bottom;
      // y goes down. bottom is high y.
      // dist from bottom = bottom - clientY.
      let val = (bottom - clientY) / height;
      val = Math.max(0, Math.min(1, val));
      
      indicator.style.bottom = `${val * 100}%`;
      this.emit("user-power-change", val);
      return val;
    };

    const onMove = (e: PointerEvent) => {
      e.preventDefault();
      updatePower(e.clientY);
    };

    const onUp = (e: PointerEvent) => {
      e.preventDefault();
      const val = updatePower(e.clientY);
      this.emit("user-power-release", val);
      indicator.style.bottom = '0%';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      updatePower(e.clientY);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    container.addEventListener('pointerdown', onDown);

    this.powerCleanup = () => {
      container.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }

  addSvgDefs(svg: SVGSVGElement) {
    // Check if defs already exist
    if (svg.querySelector('defs#ball-defs')) return;

    const defs = document.createElementNS(SVG_NS, "defs");
    defs.id = "ball-defs";

    // Ball highlight gradient - gives 3D glossy look
    const highlightGradient = document.createElementNS(SVG_NS, "radialGradient");
    highlightGradient.id = "ball-highlight-gradient";
    highlightGradient.setAttribute("cx", "30%");
    highlightGradient.setAttribute("cy", "30%");
    highlightGradient.setAttribute("r", "70%");

    const stop1 = document.createElementNS(SVG_NS, "stop");
    stop1.setAttribute("offset", "0%");
    stop1.setAttribute("stop-color", "white");
    stop1.setAttribute("stop-opacity", "0.6");
    highlightGradient.appendChild(stop1);

    const stop2 = document.createElementNS(SVG_NS, "stop");
    stop2.setAttribute("offset", "40%");
    stop2.setAttribute("stop-color", "white");
    stop2.setAttribute("stop-opacity", "0.1");
    highlightGradient.appendChild(stop2);

    const stop3 = document.createElementNS(SVG_NS, "stop");
    stop3.setAttribute("offset", "100%");
    stop3.setAttribute("stop-color", "black");
    stop3.setAttribute("stop-opacity", "0.2");
    highlightGradient.appendChild(stop3);

    defs.appendChild(highlightGradient);

    // Wood grain gradient for rails
    const woodGradient = document.createElementNS(SVG_NS, "linearGradient");
        // Outer frame wood gradient (distinct, deeper tone)
        const frameWood = document.createElementNS(SVG_NS, "linearGradient");
        frameWood.id = "frame-wood";
        frameWood.setAttribute("x1", "0%");
        frameWood.setAttribute("y1", "0%");
        frameWood.setAttribute("x2", "100%");
        frameWood.setAttribute("y2", "100%");
        const frameStops = [
          { offset: "0%", color: "#3b2414" },
          { offset: "25%", color: "#4a2e19" },
          { offset: "50%", color: "#56351e" },
          { offset: "75%", color: "#432918" },
          { offset: "100%", color: "#2e1b10" },
        ];
        frameStops.forEach(({ offset, color }) => {
          const s = document.createElementNS(SVG_NS, "stop");
          s.setAttribute("offset", offset);
          s.setAttribute("stop-color", color);
          frameWood.appendChild(s);
        });
        defs.appendChild(frameWood);
    woodGradient.id = "wood-grain";
    woodGradient.setAttribute("x1", "0%");
    woodGradient.setAttribute("y1", "0%");
    woodGradient.setAttribute("x2", "100%");
    woodGradient.setAttribute("y2", "100%");

    const woodStops = [
      { offset: "0%", color: "#5d3a1a" },
      { offset: "20%", color: "#6b4423" },
      { offset: "40%", color: "#4a2c12" },
      { offset: "60%", color: "#6b4423" },
      { offset: "80%", color: "#5d3a1a" },
      { offset: "100%", color: "#4a2c12" },
    ];
    woodStops.forEach(({ offset, color }) => {
      const stop = document.createElementNS(SVG_NS, "stop");
      stop.setAttribute("offset", offset);
      stop.setAttribute("stop-color", color);
      woodGradient.appendChild(stop);
    });
    defs.appendChild(woodGradient);

    // Felt texture gradient
    const feltGradient = document.createElementNS(SVG_NS, "radialGradient");
    feltGradient.id = "felt-gradient";
    feltGradient.setAttribute("cx", "50%");
    feltGradient.setAttribute("cy", "50%");
    feltGradient.setAttribute("r", "70%");

    const feltStop1 = document.createElementNS(SVG_NS, "stop");
    feltStop1.setAttribute("offset", "0%");
    feltStop1.setAttribute("stop-color", "#0d5c35");
    feltGradient.appendChild(feltStop1);

    const feltStop2 = document.createElementNS(SVG_NS, "stop");
    feltStop2.setAttribute("offset", "100%");
    feltStop2.setAttribute("stop-color", "#073d22");
    feltGradient.appendChild(feltStop2);

    defs.appendChild(feltGradient);

    // Pocket gradient for depth - darker to match being cut into wood
    const pocketGradient = document.createElementNS(SVG_NS, "radialGradient");
    pocketGradient.id = "pocket-gradient";
    pocketGradient.setAttribute("cx", "50%");
    pocketGradient.setAttribute("cy", "50%");
    pocketGradient.setAttribute("r", "50%");

    const pocketStop1 = document.createElementNS(SVG_NS, "stop");
    pocketStop1.setAttribute("offset", "0%");
    pocketStop1.setAttribute("stop-color", "#000000");
    pocketGradient.appendChild(pocketStop1);

    const pocketStop2 = document.createElementNS(SVG_NS, "stop");
    pocketStop2.setAttribute("offset", "70%");
    pocketStop2.setAttribute("stop-color", "#000000");
    pocketGradient.appendChild(pocketStop2);

    const pocketStop3 = document.createElementNS(SVG_NS, "stop");
    pocketStop3.setAttribute("offset", "100%");
    pocketStop3.setAttribute("stop-color", "#1a1008");
    pocketGradient.appendChild(pocketStop3);

    defs.appendChild(pocketGradient);

    // Horizontal rails (top/bottom) - grain runs along the length of the rail
    const railHorizontal = document.createElementNS(SVG_NS, "linearGradient");
    railHorizontal.id = "rail-horizontal";
    railHorizontal.setAttribute("x1", "0%");
    railHorizontal.setAttribute("y1", "0%");
    railHorizontal.setAttribute("x2", "100%");
    railHorizontal.setAttribute("y2", "0%");

    // Wood grain - subtle variation along the length
    const hGrainStops = [
      { offset: "0%", color: "#5a3d2b" },
      { offset: "10%", color: "#4e3222" },
      { offset: "25%", color: "#5a3d2b" },
      { offset: "40%", color: "#523828" },
      { offset: "55%", color: "#5a3d2b" },
      { offset: "70%", color: "#4e3222" },
      { offset: "85%", color: "#5a3d2b" },
      { offset: "100%", color: "#523828" },
    ];
    hGrainStops.forEach(({ offset, color }) => {
      const stop = document.createElementNS(SVG_NS, "stop");
      stop.setAttribute("offset", offset);
      stop.setAttribute("stop-color", color);
      railHorizontal.appendChild(stop);
    });
    defs.appendChild(railHorizontal);

    // Vertical rails (left/right) - grain runs along the length of the rail
    const railVertical = document.createElementNS(SVG_NS, "linearGradient");
    railVertical.id = "rail-vertical";
    railVertical.setAttribute("x1", "0%");
    railVertical.setAttribute("y1", "0%");
    railVertical.setAttribute("x2", "0%");
    railVertical.setAttribute("y2", "100%");

    // Wood grain - subtle variation along the length
    const vGrainStops = [
      { offset: "0%", color: "#5a3d2b" },
      { offset: "10%", color: "#4e3222" },
      { offset: "25%", color: "#5a3d2b" },
      { offset: "40%", color: "#523828" },
      { offset: "55%", color: "#5a3d2b" },
      { offset: "70%", color: "#4e3222" },
      { offset: "85%", color: "#5a3d2b" },
      { offset: "100%", color: "#523828" },
    ];
    vGrainStops.forEach(({ offset, color }) => {
      const stop = document.createElementNS(SVG_NS, "stop");
      stop.setAttribute("offset", offset);
      stop.setAttribute("stop-color", color);
      railVertical.appendChild(stop);
    });
    defs.appendChild(railVertical);

    // Metal dot gradient for decorative screws/inlays
    const metalGradient = document.createElementNS(SVG_NS, "radialGradient");
    metalGradient.id = "metal-dot";
    metalGradient.setAttribute("cx", "35%");
    metalGradient.setAttribute("cy", "35%");
    metalGradient.setAttribute("r", "60%");

    const metalStop1 = document.createElementNS(SVG_NS, "stop");
    metalStop1.setAttribute("offset", "0%");
    metalStop1.setAttribute("stop-color", "#b8c4d0");
    metalGradient.appendChild(metalStop1);

    const metalStop2 = document.createElementNS(SVG_NS, "stop");
    metalStop2.setAttribute("offset", "50%");
    metalStop2.setAttribute("stop-color", "#8090a0");
    metalGradient.appendChild(metalStop2);

    const metalStop3 = document.createElementNS(SVG_NS, "stop");
    metalStop3.setAttribute("offset", "100%");
    metalStop3.setAttribute("stop-color", "#506070");
    metalGradient.appendChild(metalStop3);

    defs.appendChild(metalGradient);

    // Cue stick shaft gradient (maple wood)
    const cueShaft = document.createElementNS(SVG_NS, "linearGradient");
    cueShaft.id = "cue-shaft";
    cueShaft.setAttribute("x1", "0%");
    cueShaft.setAttribute("y1", "0%");
    cueShaft.setAttribute("x2", "0%");
    cueShaft.setAttribute("y2", "100%");
    const shaftStops = [
      { offset: "0%", color: "#f5deb3" },
      { offset: "30%", color: "#deb887" },
      { offset: "50%", color: "#f5deb3" },
      { offset: "70%", color: "#d2b48c" },
      { offset: "100%", color: "#c4a67a" },
    ];
    shaftStops.forEach(({ offset, color }) => {
      const s = document.createElementNS(SVG_NS, "stop");
      s.setAttribute("offset", offset);
      s.setAttribute("stop-color", color);
      cueShaft.appendChild(s);
    });
    defs.appendChild(cueShaft);

    // Cue stick butt gradient (darker wood)
    const cueButt = document.createElementNS(SVG_NS, "linearGradient");
    cueButt.id = "cue-butt";
    cueButt.setAttribute("x1", "0%");
    cueButt.setAttribute("y1", "0%");
    cueButt.setAttribute("x2", "0%");
    cueButt.setAttribute("y2", "100%");
    const buttStops = [
      { offset: "0%", color: "#4a3728" },
      { offset: "25%", color: "#5c4033" },
      { offset: "50%", color: "#3d2b1f" },
      { offset: "75%", color: "#5c4033" },
      { offset: "100%", color: "#4a3728" },
    ];
    buttStops.forEach(({ offset, color }) => {
      const s = document.createElementNS(SVG_NS, "stop");
      s.setAttribute("offset", offset);
      s.setAttribute("stop-color", color);
      cueButt.appendChild(s);
    });
    defs.appendChild(cueButt);

    // Drop shadow filter for depth
    const dropShadow = document.createElementNS(SVG_NS, "filter");
    dropShadow.id = "drop-shadow";
    dropShadow.setAttribute("x", "-20%");
    dropShadow.setAttribute("y", "-20%");
    dropShadow.setAttribute("width", "140%");
    dropShadow.setAttribute("height", "140%");

    const feDropShadow = document.createElementNS(SVG_NS, "feDropShadow");
    feDropShadow.setAttribute("dx", "0");
    feDropShadow.setAttribute("dy", "0.005");
    feDropShadow.setAttribute("stdDeviation", "0.008");
    feDropShadow.setAttribute("flood-color", "#000");
    feDropShadow.setAttribute("flood-opacity", "0.5");
    dropShadow.appendChild(feDropShadow);

    defs.appendChild(dropShadow);

    // Inner shadow for pockets
    const innerShadow = document.createElementNS(SVG_NS, "filter");
    innerShadow.id = "inner-shadow";
    innerShadow.setAttribute("x", "-50%");
    innerShadow.setAttribute("y", "-50%");
    innerShadow.setAttribute("width", "200%");
    innerShadow.setAttribute("height", "200%");

    const feGaussian = document.createElementNS(SVG_NS, "feGaussianBlur");
    feGaussian.setAttribute("in", "SourceAlpha");
    feGaussian.setAttribute("stdDeviation", "0.005");
    feGaussian.setAttribute("result", "blur");
    innerShadow.appendChild(feGaussian);

    const feOffset = document.createElementNS(SVG_NS, "feOffset");
    feOffset.setAttribute("in", "blur");
    feOffset.setAttribute("dx", "0");
    feOffset.setAttribute("dy", "0.003");
    feOffset.setAttribute("result", "offsetBlur");
    innerShadow.appendChild(feOffset);

    const feComposite = document.createElementNS(SVG_NS, "feComposite");
    feComposite.setAttribute("in", "SourceGraphic");
    feComposite.setAttribute("in2", "offsetBlur");
    feComposite.setAttribute("operator", "over");
    innerShadow.appendChild(feComposite);

    defs.appendChild(innerShadow);

    svg.insertBefore(defs, svg.firstChild);
  }

  handleDeactivate() {
    window.removeEventListener("resize", this.handleWindowResize);
    window.removeEventListener("orientationchange", this.handleWindowResize);
    this.container.parentElement?.removeEventListener("pointerdown", this.handlePointerDown);
    this.container.parentElement?.removeEventListener("pointermove", this.handlePointerMove);
    this.container.parentElement?.removeEventListener("pointerup", this.handlePointerUp);
    
    if (this.powerCleanup) {
      this.powerCleanup();
      this.powerCleanup = undefined;
    }

    this.container.remove();
  }

  handleStart() {}

  // Store ball rotation state
  ballState = new Map<string, { q: Quaternion; pos: { x: number; y: number } }>();

  tableConfigMemo = Memo.init();
  handleWindowResize = () => {
    const table = this.context?.table;
    if (!this.container || !table) return;
    if (this.tableConfigMemo.update(table.width, table.height, window.innerWidth, window.innerHeight)) {
      const width = table.width * 1.3;
      const height = table.height * 1.3;
      const isPortrait = window.innerWidth < window.innerHeight;
      if (isPortrait) {
        this.container.classList.add("portrait");
        this.container.parentElement?.setAttribute("viewBox", `-${height * 0.5} -${width * 0.5} ${height} ${width}`);
      } else {
        this.container.classList.remove("portrait");
        this.container.parentElement?.setAttribute("viewBox", `-${width * 0.5} -${height * 0.5} ${width} ${height}`);
      }
    }
  };

  getSvgPoint = (event: PointerEvent) => {
    if (!this.container) return;
    const domPoint = new DOMPoint(event.clientX, event.clientY);
    const transform = this.container.getScreenCTM();
    if (!transform) return;
    const svgPoint = domPoint.matrixTransform(transform.inverse());
    return svgPoint;
  };

  pointerDown = false;

  handlePointerDown = (event: PointerEvent) => {
    this.pointerDown = true;
    const point = this.getSvgPoint(event);
    if (!point) return;
    this.emit("user-pointer-start", point);
  };

  handlePointerMove = (event: PointerEvent) => {
    // if (!this.context.next) return;
    if (!this.pointerDown) return;
    event.preventDefault();
    const point = this.getSvgPoint(event);
    if (!point) return;
    this.emit("user-pointer-move", point);
  };

  handlePointerUp = (event: PointerEvent) => {
    this.pointerDown = false;
    const point = this.getSvgPoint(event);
    if (!point) return;
    this.emit("user-pointer-end", point);
  };

  handleFrameLoop = () => {
    if (!this.context.balls || !this.context.rails || !this.context.pockets) return;

    const data: (Ball | Rail | Pocket | CueStick | Table)[] = [
      this.context.table,
      ...this.context.rails,
      ...this.context.pockets,
      ...this.context.balls,
    ];
    
    // Only include cue if it exists
    if (this.context.cue) {
      data.push(this.context.cue);
    }

    this.dataset.data(data);
  };

  ballDriver = Driver.create<Ball, Element>({
    filter: (data) => data.type == "ball",
    enter: (data) => {
      const group = document.createElementNS(SVG_NS, "g");
      group.classList.add("ball-group");
      
      // Initialize state if not exists
      if (!this.ballState.has(data.key)) {
        this.ballState.set(data.key, { 
          q: new Quaternion(), 
          pos: { ...data.position } 
        });
      }

      // Determine ball properties
      let number: number | null = null;
      let type: 'solid' | 'stripe' | 'cue' | '8' = 'solid';
      
      if (data.color === 'white') {
        type = 'cue';
      } else if (data.color === 'black') {
        number = 8;
        type = '8';
      } else {
        const parts = data.color.split('-');
        const colorName = parts[0];
        const style = parts[1];
        
        const colorToNumber: Record<string, number> = {
          'yellow': 1, 'blue': 2, 'red': 3, 'purple': 4, 
          'orange': 5, 'green': 6, 'burgundy': 7
        };
        
        if (colorToNumber[colorName]) {
          number = colorToNumber[colorName];
          if (style === 'stripe') {
            number += 8;
            type = 'stripe';
          }
        }
      }

      const r = data.radius - STROKE_WIDTH;

      // 1. Base Circle (The main color)
      const baseCircle = document.createElementNS(SVG_NS, "circle");
      baseCircle.setAttribute("r", String(r));
      baseCircle.classList.add("ball-circle");
      
      // For stripes, the base is the COLOR (we will draw white caps on top)
      // For solids, the base is the COLOR
      // For cue, base is white
      if (type === 'cue') {
        baseCircle.classList.add("ball", "white");
      } else if (type === '8') {
        baseCircle.classList.add("ball", "black");
      } else {
        // Both solid and stripe get the color base
        baseCircle.classList.add("ball", data.color.split('-')[0]);
      }
      group.appendChild(baseCircle);

      // 2. Dynamic Elements Group (Caps, Number)
      const dynamicGroup = document.createElementNS(SVG_NS, "g");
      group.appendChild(dynamicGroup);

      // 3. Gloss/Highlight (Fixed on top)
      const highlight = document.createElementNS(SVG_NS, "circle");
      highlight.setAttribute("r", String(r));
      highlight.setAttribute("cx", "0");
      highlight.setAttribute("cy", "0");
      highlight.classList.add("ball-highlight");
      group.appendChild(highlight);

      // Store metadata for update
      (group as any).__ballMeta = { type, number, r, dynamicGroup };

      this.ballsGroup.appendChild(group);
      return group;
    },
    update: (data, element) => {
      element.setAttribute("transform", `translate(${data.position.x}, ${data.position.y})`);

      const meta = (element as any).__ballMeta;
      if (!meta) return;
      const { type, number, r, dynamicGroup } = meta;

      // Update Rotation State
      let state = this.ballState.get(data.key);
      if (!state) {
         state = { q: new Quaternion(), pos: { ...data.position } };
         this.ballState.set(data.key, state);
      }

      // Calculate movement delta
      const dx = data.position.x - state.pos.x;
      const dy = data.position.y - state.pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Update stored position
      state.pos.x = data.position.x;
      state.pos.y = data.position.y;

      // Update Quaternion based on rolling
      if (dist > 0.0001) {
        const axis = { x: -dy / dist, y: dx / dist, z: 0 };
        const angle = dist / data.radius; 
        const qRot = Quaternion.fromAxisAngle(axis, angle);
        state.q = qRot.multiply(state.q).normalize();
      }
      
      // Clear dynamic elements
      while (dynamicGroup.firstChild) {
        dynamicGroup.removeChild(dynamicGroup.firstChild);
      }

      // Pre-calculate rotated basis vectors
      const xAxis = state.q.rotateVector({ x: 1, y: 0, z: 0 });
      const yAxis = state.q.rotateVector({ x: 0, y: 1, z: 0 });
      const zAxis = state.q.rotateVector({ x: 0, y: 0, z: 1 });

      // Helper to create matrix transform string
      const getMatrix = (basisX: any, basisY: any, center: any) => {
        return `matrix(${basisX.x},${basisX.y},${basisY.x},${basisY.y},${center.x},${center.y})`;
      };

      // Render Stripe Caps (White)
      if (type === 'stripe') {
        const offset = r * 0.65;
        const steps = 20;

        const drawCapStack = (sign: 1 | -1) => {
          for (let i = 0; i < steps; i++) {
            const t = i / (steps - 1);
            const h = offset + (r - offset) * t;
            const sliceRadius = Math.sqrt(r*r - h*h);
            
            // Position: (0, sign * h, 0)
            const center = { 
              x: yAxis.x * sign * h, 
              y: yAxis.y * sign * h, 
              z: yAxis.z * sign * h 
            };

            // Smooth fade out at the edges to prevent popping
            const fadeStart = 0.1 * r;
            const fadeEnd = -0.1 * r;

            if (center.z > fadeEnd) { 
              let opacity = 1;
              if (center.z < fadeStart) {
                opacity = (center.z - fadeEnd) / (fadeStart - fadeEnd);
              }

              const cap = document.createElementNS(SVG_NS, "circle");
              cap.setAttribute("transform", getMatrix(xAxis, zAxis, center));
              cap.setAttribute("r", String(sliceRadius));
              cap.setAttribute("fill", "white");
              if (opacity < 1) {
                cap.setAttribute("opacity", String(opacity));
              }
              dynamicGroup.appendChild(cap);
            }
          }
        };
        
        drawCapStack(1);
        drawCapStack(-1);
      }

      // Render Number Spot (White)
      if (number !== null) {
        // Number at Local Z (0, 0, r)
        const numCenter = { 
          x: zAxis.x * r, 
          y: zAxis.y * r, 
          z: zAxis.z * r 
        };

        const fadeStart = 0.1 * r;
        const fadeEnd = -0.1 * r;

        if (numCenter.z > fadeEnd) { // Visible
          let opacity = 1;
          if (numCenter.z < fadeStart) {
            opacity = (numCenter.z - fadeEnd) / (fadeStart - fadeEnd);
          }

          const spot = document.createElementNS(SVG_NS, "g");
          spot.setAttribute("transform", getMatrix(xAxis, yAxis, numCenter));
          if (opacity < 1) {
            spot.setAttribute("opacity", String(opacity));
          }
          
          const spotCircle = document.createElementNS(SVG_NS, "circle");
          spotCircle.setAttribute("r", String(r * 0.4));
          spotCircle.setAttribute("fill", "white");
          spot.appendChild(spotCircle);

          const text = document.createElementNS(SVG_NS, "text");
          text.textContent = String(number);
          text.classList.add("ball-text");
          text.setAttribute("dy", "0.1em");
          text.setAttribute("font-size", String(r * 0.45));
          spot.appendChild(text);

          dynamicGroup.appendChild(spot);
        }
      }
    },
    exit: (data, element) => {
      this.ballState.delete(data.key);
      element.remove();
    },
  });

  tableDriver = Driver.create<Table, Element>({
    filter: (data) => data.type == "table",
    enter: (data) => {
      const group = document.createElementNS(SVG_NS, "g");
      
      const element = document.createElementNS(SVG_NS, "rect");
      const w = data.width + data.pocketRadius * 1.5;
      const h = data.height + data.pocketRadius * 1.5;
      element.setAttribute("x", String(-w * 0.5 - STROKE_WIDTH));
      element.setAttribute("y", String(-h * 0.5 - STROKE_WIDTH));
      element.setAttribute("width", String(w + STROKE_WIDTH * 2));
      element.setAttribute("height", String(h + STROKE_WIDTH * 2));
      element.classList.add("table");
      group.appendChild(element);

      // Outer frame (slightly larger than table rectangle)
      const frame = document.createElementNS(SVG_NS, "rect");
      const framePad = data.pocketRadius * 2.2; // thickness of wood frame
      frame.setAttribute("x", String(-w * 0.5 - framePad));
      frame.setAttribute("y", String(-h * 0.5 - framePad));
      frame.setAttribute("width", String(w + framePad * 2));
      frame.setAttribute("height", String(h + framePad * 2));
      frame.classList.add("frame");
      this.frameGroup.appendChild(frame);

      // Add decorative metal dots along the rails
      const dotRadius = data.pocketRadius * 0.15;
      const railWidth = data.pocketRadius * 0.75;
      const dotOffset = railWidth * 0.5;
      
      // Positions for dots - evenly spaced along each side
      const tableW = data.width * 0.5;
      const tableH = data.height * 0.5;
      const outerW = w * 0.5;
      const outerH = h * 0.5;
      
      // Top and bottom rails - 3 dots each (avoiding pockets)
      const hDotPositions = [-tableW * 0.5, 0, tableW * 0.5];
      // Left and right rails - 2 dots each
      const vDotPositions = [-tableH * 0.35, tableH * 0.35];
      
      const addDot = (x: number, y: number) => {
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", String(x));
        dot.setAttribute("cy", String(y));
        dot.setAttribute("r", String(dotRadius));
        dot.setAttribute("fill", "url(#metal-dot)");
        dot.setAttribute("stroke", "#3a4550");
        dot.setAttribute("stroke-width", String(dotRadius * 0.15));
        group.appendChild(dot);
      };
      
      // Top rail dots
      hDotPositions.forEach(x => addDot(x, -outerH + dotOffset));
      // Bottom rail dots
      hDotPositions.forEach(x => addDot(x, outerH - dotOffset));
      // Left rail dots
      vDotPositions.forEach(y => addDot(-outerW + dotOffset, y));
      // Right rail dots
      vDotPositions.forEach(y => addDot(outerW - dotOffset, y));

      this.tableGroup.appendChild(group);
      this.handleWindowResize();
      return group;
    },
    update: (data, element) => {},
    exit: (data, element) => {
      element.remove();
    },
  });

  railDriver = Driver.create<Rail, Element>({
    filter: (data) => data.type == "rail",
    enter: (data) => {
      const element = document.createElementNS(SVG_NS, "polygon");
      element.setAttribute("points", String(data.vertices?.map((v) => `${v.x},${v.y}`).join(" ")));
      element.classList.add("rail");
      
      // Determine if rail is horizontal or vertical based on vertices
      if (data.vertices && data.vertices.length >= 2) {
        const xs = data.vertices.map(v => v.x);
        const ys = data.vertices.map(v => v.y);
        const width = Math.max(...xs) - Math.min(...xs);
        const height = Math.max(...ys) - Math.min(...ys);
        
        // If wider than tall, it's horizontal (top/bottom)
        if (width > height) {
          element.setAttribute("fill", "url(#rail-horizontal)");
        } else {
          element.setAttribute("fill", "url(#rail-vertical)");
        }
      }
      
      this.tableGroup.appendChild(element);
      return element;
    },
    update: (data, element) => {},
    exit: (data, element) => {
      element.remove();
    },
  });

  pocketDriver = Driver.create<Pocket, Element>({
    filter: (data) => data.type == "pocket",
    enter: (data) => {
      const group = document.createElementNS(SVG_NS, "g");
      
      // Outer wood surround (shows thickness outside hole)
      const outerWood = document.createElementNS(SVG_NS, "circle");
      outerWood.setAttribute("cx", String(data.position.x));
      outerWood.setAttribute("cy", String(data.position.y));
      outerWood.setAttribute("r", String(data.radius * 1.35));
      outerWood.setAttribute("fill", "url(#frame-wood)");
      outerWood.setAttribute("stroke", "#2a1a0a");
      outerWood.setAttribute("stroke-width", String(data.radius * 0.15));
      group.appendChild(outerWood);

      // Inner bevel ring
      const bevelRing = document.createElementNS(SVG_NS, "circle");
      bevelRing.setAttribute("cx", String(data.position.x));
      bevelRing.setAttribute("cy", String(data.position.y));
      bevelRing.setAttribute("r", String(data.radius * 1.1));
      bevelRing.setAttribute("fill", "#1b120a");
      bevelRing.setAttribute("opacity", "0.7");
      group.appendChild(bevelRing);

      // Main pocket hole
      const element = document.createElementNS(SVG_NS, "circle");
      element.setAttribute("cx", String(data.position.x));
      element.setAttribute("cy", String(data.position.y));
      element.setAttribute("r", String(data.radius));
      element.classList.add("pocket");
      group.appendChild(element);

      this.tableGroup.appendChild(group);
      return group;
    },
    update: (data, element) => {},
    exit: (data, element) => {
      element.remove();
    },
  });

  cueDriver = Driver.create<CueStick, Element>({
    filter: (data) => data.type == "cue",
    enter: (data) => {
      const group = document.createElementNS(SVG_NS, "g");
      group.classList.add("cue-group");
      
      // Guide line (Solid)
      const guideLine = document.createElementNS(SVG_NS, "line");
      guideLine.classList.add("guide-line");
      guideLine.setAttribute("stroke", "white");
      guideLine.setAttribute("stroke-width", "0.002");
      guideLine.setAttribute("opacity", "0.5");
      group.appendChild(guideLine);

      // Target Path Line (Direction hit ball will go)
      const targetLine = document.createElementNS(SVG_NS, "line");
      targetLine.classList.add("target-line");
      targetLine.setAttribute("stroke", "white");
      targetLine.setAttribute("stroke-width", "0.002");
      targetLine.setAttribute("opacity", "0.5");
      targetLine.style.display = "none";
      group.appendChild(targetLine);

      // Deflection Path Line (Direction cue ball will go)
      const deflectLine = document.createElementNS(SVG_NS, "line");
      deflectLine.classList.add("deflect-line");
      deflectLine.setAttribute("stroke", "white");
      deflectLine.setAttribute("stroke-width", "0.002");
      deflectLine.setAttribute("opacity", "0.3");
      deflectLine.style.display = "none";
      group.appendChild(deflectLine);
      
      const shadow = document.createElementNS(SVG_NS, "line");
      shadow.classList.add("cue-shadow");
      group.appendChild(shadow);
      
      const butt = document.createElementNS(SVG_NS, "line");
      butt.classList.add("cue-butt");
      group.appendChild(butt);
      
      const wrap = document.createElementNS(SVG_NS, "line");
      wrap.classList.add("cue-wrap");
      group.appendChild(wrap);
      
      const shaft = document.createElementNS(SVG_NS, "line");
      shaft.classList.add("cue-shaft");
      group.appendChild(shaft);
      
      const ferrule = document.createElementNS(SVG_NS, "line");
      ferrule.classList.add("cue-ferrule");
      group.appendChild(ferrule);
      
      const tip = document.createElementNS(SVG_NS, "circle");
      tip.classList.add("cue-tip");
      tip.setAttribute("r", "0.007");
      group.appendChild(tip);

      // Ghost Ball (Impact Indicator)
      const ghostBall = document.createElementNS(SVG_NS, "circle");
      ghostBall.classList.add("ghost-ball");
      ghostBall.setAttribute("r", "0.01"); // Will be updated to match ball radius
      ghostBall.setAttribute("fill", "none");
      ghostBall.setAttribute("stroke", "white");
      ghostBall.setAttribute("stroke-width", "0.002");
      ghostBall.setAttribute("stroke-dasharray", "0.005, 0.005");
      ghostBall.setAttribute("opacity", "0.5");
      ghostBall.style.display = "none";
      group.appendChild(ghostBall);
      
      // Cache element references to avoid querySelector each frame
      (group as any).__cueElements = { shadow, butt, wrap, shaft, ferrule, tip, guideLine, ghostBall, targetLine, deflectLine };
      
      this.cueGroup.appendChild(group);
      return group;
    },
    update: (data, element) => {
      const cached = (element as any).__cueElements;
      if (!cached) return;
      
      const { shadow, butt, wrap, shaft, ferrule, tip, guideLine, ghostBall, targetLine, deflectLine } = cached;
      
      // start = cue ball position, end = opposite side of where ball will go
      // The ball shoots AWAY from cue.end, so the cue tip should be OPPOSITE to cue.end
      const ballX = data.start.x;
      const ballY = data.start.y;
      const endX = data.end.x;
      const endY = data.end.y;
      
      // Direction from end toward ball (this points toward where ball will go)
      // Cue should be on the OPPOSITE side, so we flip it
      const dx = ballX - endX;
      const dy = ballY - endY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      // Hide if distance too small
      if (dist < 0.005) {
        (element as SVGElement).style.display = "none";
        return;
      }
      (element as SVGElement).style.display = "";
      
      // Normalized direction (pointing from ball AWAY from cue.end = toward shot direction)
      // Cue tip is on opposite side, so we use negative direction
      const nx = -dx / dist;
      const ny = -dy / dist;

      // --- Guide Line Raycast ---
      // Shot direction is (nx, ny) * -1 = (dx/dist, dy/dist)
      // Wait, nx is -dx/dist. So shot direction is -nx, -ny.
      // Let's re-verify:
      // cue.end is handle. cue.start is ball.
      // Vector from handle to ball is (start - end) = (dx, dy).
      // This is the direction the stick is pointing.
      // So shot direction is (dx, dy) normalized.
      const shotDx = dx / dist;
      const shotDy = dy / dist;

      let hitDist = 2.0; // Max length
      let hitBallRadius = 0;
      let hitType = 'none';
      let hitBallPos = { x: 0, y: 0 };

      // 1. Check Walls
      const table = this.context.table;
      if (table) {
        const w = table.width / 2;
        const h = table.height / 2;
        // Ray: O + tD.
        // x = ox + t*dx.
        // t = (x - ox) / dx.
        
        if (shotDx > 0.0001) {
           const t = (w - ballX) / shotDx;
           if (t > 0 && t < hitDist) { hitDist = t; hitType = 'wall'; }
        } else if (shotDx < -0.0001) {
           const t = (-w - ballX) / shotDx;
           if (t > 0 && t < hitDist) { hitDist = t; hitType = 'wall'; }
        }
        
        if (shotDy > 0.0001) {
           const t = (h - ballY) / shotDy;
           if (t > 0 && t < hitDist) { hitDist = t; hitType = 'wall'; }
        } else if (shotDy < -0.0001) {
           const t = (-h - ballY) / shotDy;
           if (t > 0 && t < hitDist) { hitDist = t; hitType = 'wall'; }
        }
      }

      // 2. Check Balls
      if (this.context.balls) {
        const ballRadius = data.ball.radius; // Assuming all balls same radius
        const collisionRadius = ballRadius * 2;
        const collisionRadiusSq = collisionRadius * collisionRadius;

        for (const otherBall of this.context.balls) {
          if (otherBall.key === data.ball.key) continue; // Skip cue ball
          
          // Vector to ball center
          const vx = otherBall.position.x - ballX;
          const vy = otherBall.position.y - ballY;
          
          // Project onto ray
          const t = vx * shotDx + vy * shotDy;
          
          if (t > 0) {
            // Distance squared from line
            const dSq = (vx * vx + vy * vy) - (t * t);
            
            if (dSq < collisionRadiusSq) {
              // Intersection distance
              const dt = Math.sqrt(collisionRadiusSq - dSq);
              const tHit = t - dt;
              if (tHit > 0 && tHit < hitDist) {
                hitDist = tHit;
                hitBallRadius = otherBall.radius;
                hitType = 'ball';
                hitBallPos = otherBall.position;
              }
            }
          }
        }
      }

      const guideEndX = ballX + shotDx * hitDist;
      const guideEndY = ballY + shotDy * hitDist;

      guideLine.setAttribute("x1", String(ballX));
      guideLine.setAttribute("y1", String(ballY));
      guideLine.setAttribute("x2", String(guideEndX));
      guideLine.setAttribute("y2", String(guideEndY));

      // Update Ghost Ball and Direction Lines
      if (hitType === 'ball') {
        ghostBall.style.display = "";
        ghostBall.setAttribute("cx", String(guideEndX));
        ghostBall.setAttribute("cy", String(guideEndY));
        ghostBall.setAttribute("r", String(hitBallRadius));

        // Calculate impact normal (direction target ball will go)
        // Vector from ghost ball center (guideEnd) to target ball center (hitBallPos)
        const nx = hitBallPos.x - guideEndX;
        const ny = hitBallPos.y - guideEndY;
        const nLen = Math.sqrt(nx * nx + ny * ny);
        
        if (nLen > 0.0001) {
            const normX = nx / nLen;
            const normY = ny / nLen;
            
            // Target Line (from target ball center outwards)
            const targetLen = 0.08; // Length of indicator
            targetLine.style.display = "";
            targetLine.setAttribute("x1", String(hitBallPos.x));
            targetLine.setAttribute("y1", String(hitBallPos.y));
            targetLine.setAttribute("x2", String(hitBallPos.x + normX * targetLen));
            targetLine.setAttribute("y2", String(hitBallPos.y + normY * targetLen));

            // Deflection Line (tangent to impact)
            // Cue ball velocity is (shotDx, shotDy)
            // Tangent component = Velocity - Normal Component
            // V_dot_N = V . N
            const vDotN = shotDx * normX + shotDy * normY;
            const tanX = shotDx - vDotN * normX;
            const tanY = shotDy - vDotN * normY;
            const tanLen = Math.sqrt(tanX * tanX + tanY * tanY);
            
            if (tanLen > 0.001) {
                const deflectLen = 0.06;
                // Normalize tangent for consistent line length, or keep proportional to show energy transfer?
                // Let's normalize for direction indication
                const dX = tanX / tanLen;
                const dY = tanY / tanLen;
                
                deflectLine.style.display = "";
                deflectLine.setAttribute("x1", String(guideEndX));
                deflectLine.setAttribute("y1", String(guideEndY));
                deflectLine.setAttribute("x2", String(guideEndX + dX * deflectLen));
                deflectLine.setAttribute("y2", String(guideEndY + dY * deflectLen));
            } else {
                deflectLine.style.display = "none";
            }
        }
      } else {
        ghostBall.style.display = "none";
        targetLine.style.display = "none";
        deflectLine.style.display = "none";
      }
      // --------------------------
      
      // Cue dimensions
      const cueLength = 0.6;
      const minGap = 0.02;
      const gap = minGap + dist * 0.08;
      
      // Cue TIP position (behind the ball, opposite to shot direction)
      const tipX = ballX + nx * gap;
      const tipY = ballY + ny * gap;
      
      // Cue BUTT position (further behind)
      const buttX = tipX + nx * cueLength;
      const buttY = tipY + ny * cueLength;
      
      // Section lengths
      const tipLen = 0.01;
      const ferruleLen = 0.018;
      const shaftLen = cueLength * 0.5;
      const wrapLen = 0.05;
      
      let pos = 0;
      
      // Tip (closest to ball)
      tip.setAttribute("cx", String(tipX));
      tip.setAttribute("cy", String(tipY));
      pos += tipLen;
      
      // Ferrule
      ferrule.setAttribute("x1", String(tipX + nx * pos));
      ferrule.setAttribute("y1", String(tipY + ny * pos));
      pos += ferruleLen;
      ferrule.setAttribute("x2", String(tipX + nx * pos));
      ferrule.setAttribute("y2", String(tipY + ny * pos));
      
      // Shaft
      shaft.setAttribute("x1", String(tipX + nx * pos));
      shaft.setAttribute("y1", String(tipY + ny * pos));
      pos += shaftLen;
      shaft.setAttribute("x2", String(tipX + nx * pos));
      shaft.setAttribute("y2", String(tipY + ny * pos));
      
      // Wrap
      wrap.setAttribute("x1", String(tipX + nx * pos));
      wrap.setAttribute("y1", String(tipY + ny * pos));
      pos += wrapLen;
      wrap.setAttribute("x2", String(tipX + nx * pos));
      wrap.setAttribute("y2", String(tipY + ny * pos));
      
      // Butt
      butt.setAttribute("x1", String(tipX + nx * pos));
      butt.setAttribute("y1", String(tipY + ny * pos));
      butt.setAttribute("x2", String(buttX));
      butt.setAttribute("y2", String(buttY));
      
      // Shadow
      const so = 0.005;
      shadow.setAttribute("x1", String(tipX + so));
      shadow.setAttribute("y1", String(tipY + so));
      shadow.setAttribute("x2", String(buttX + so));
      shadow.setAttribute("y2", String(buttY + so));
    },
    exit: (data, element) => {
      element.remove();
    },
  });

  dataset = Dataset.create<Ball | Rail | Pocket | CueStick | Table>({
    key: (data) => data.key,
  });
}
