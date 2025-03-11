// uncomment for WebGL error checking
// import 'https://greggman.github.io/webgl-lint/webgl-lint.js';

import { Position } from './helpers';

export function run() {

// Simulate a CRT's glow by drawing into a phosphor texture,
// thereby "depositing" photons into the phosphor, and then
// drawing the texture to the screen, thereby "emitting"
// a fraction of the photons from the phosphor.
// A final pass removes those photons from the phosphor texture.
//
// This makes each phosphor texel glow for a few frames after
// being "hit" by the cathod ray, and then fade out over time.
//
// The phosphor texture is ping-ponged between two sim textures
// because we need to read from the previous frame's texture
// while writing to the current frame's texture.
//
// The phosphor texture is in linear space. When drawn to the
// screen, the values are gamma corrected to sRGB.

const GAMMA = 0.9;           // gamma conversion from linear
const PHOSPHOR_FADE = 0.995; // how much to diminish photons per ms
const RAY_SPEED = 20;        // pixels per ms the cathode ray moves
const RAY_RADIUS = 1.5;      // radius of the cathode ray
const RAY_COLOR = [1, 1, 1]; // color of the cathode ray

const MAX_RAY_POINTS = 20000; // max number of points the ray can draw per frame

// all shaders use the same vertex shader that
// maps 2D screen coordinates to clip space (-1 to 1)
// and passes the texture coordinates to the fragment shader
const VERT_SHADER = `#version 300 es
in vec2 a_vertexPos;
uniform vec2 u_res;
out vec2 v_texCoord;
void main() {
  v_texCoord = a_vertexPos / u_res;
  vec2 clipSpace = a_vertexPos / u_res * 2.0 - 1.0;
  gl_Position = vec4(clipSpace, 0, 1);
}`;

// deposit photons into the phosphor texture
const RAY_FRAG_SHADER = `#version 300 es
precision mediump float;      // +/- 64K range and Inf/-Inf
precision mediump sampler2D;
in vec2 v_texCoord;
uniform sampler2D u_simTexture;
uniform vec3 u_rayPhotons; // >= 0.0
out vec3 photons;
void main() {
  vec3 prevPhotons = texture(u_simTexture, v_texCoord).rgb;
  // deposit photons
  photons = prevPhotons + u_rayPhotons;
}`;

// diminish photons in the phosphor texture
const SIM_FRAG_SHADER = `#version 300 es
precision mediump float;      // +/- 64K range and Inf/-Inf
precision mediump sampler2D;
in vec2 v_texCoord;
uniform sampler2D u_simTexture;
uniform float u_simPhosphorFade; // < 1.0
out vec3 photons;
void main() {
  vec3 prevPhotons = texture(u_simTexture, v_texCoord).rgb;
  // diminish photons
  photons = prevPhotons * u_simPhosphorFade;
}`;

// map the phosphor texture to colors
const RENDER_FRAG_SHADER = `#version 300 es
precision mediump float;      // +/- 64K range and Inf/-Inf
precision mediump sampler2D;
in vec2 v_texCoord;
uniform sampler2D u_simTexture;
uniform float u_gamma;
out vec4 outColor;
void main() {
  vec4 photons = texture(u_simTexture, v_texCoord).rgba;
  // emit photons as color
  outColor = pow(photons, vec4(u_gamma));
}`;

const canvas = document.querySelector('canvas')!;
if (!canvas) throw new Error('No canvas found');
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;
const gl = canvas.getContext('webgl2')!;
if (!gl) throw new Error('No WebGL2 context found');

// create 2 sim textures for ping-ponging storing the photons
const simTextures: WebGLTexture[] = []
for (let i = 0; i < 2; i++) {
  const simTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, simTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, canvas.width, canvas.height, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
  simTextures.push(simTexture);
}
let PREV = 0;
let CURR = 1;
function swapPrevAndCurrent() { [PREV, CURR] = [CURR, PREV]; }

// create framebuffers
const renderFramebuffer = null;         // means to use canvas as framebuffer
const simFramebuffer = gl.createFramebuffer();
gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, simFramebuffer);
gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, simTextures[PREV], 0);

// create shaders and programs
const texVertShader = createShader(gl, gl.VERTEX_SHADER, VERT_SHADER);
const rayFragShader = createShader(gl, gl.FRAGMENT_SHADER, RAY_FRAG_SHADER);
const simFragShader = createShader(gl, gl.FRAGMENT_SHADER, SIM_FRAG_SHADER);
const renderFragShader = createShader(gl, gl.FRAGMENT_SHADER, RENDER_FRAG_SHADER);

const rayProgram = createProgram(gl, texVertShader, rayFragShader);
const rayPointsAttrLoc = gl.getAttribLocation(rayProgram, 'a_vertexPos');
const rayResUniformLoc = gl.getUniformLocation(rayProgram, 'u_res');
const rayTextureLoc = gl.getUniformLocation(rayProgram, 'u_simTexture');
const rayPhotonsUniformLoc = gl.getUniformLocation(rayProgram, 'u_rayPhotons');

const simProgram = createProgram(gl, texVertShader, simFragShader);
const simCornerAttrLoc = gl.getAttribLocation(simProgram, 'a_vertexPos');
const simResUniformLoc = gl.getUniformLocation(simProgram, 'u_res');
const simTextureLoc = gl.getUniformLocation(simProgram, 'u_simTexture');
const simPhosphorFadeUniformLoc = gl.getUniformLocation(simProgram, 'u_simPhosphorFade');

const renderProgram = createProgram(gl, texVertShader, renderFragShader);
const renderCornerAttrLoc = gl.getAttribLocation(renderProgram, 'a_vertexPos');
const renderResUniformLoc = gl.getUniformLocation(renderProgram, 'u_res');
const renderTextureLoc = gl.getUniformLocation(renderProgram, 'u_simTexture');
const renderGammaUniformLoc = gl.getUniformLocation(renderProgram, 'u_gamma');

// create buffers
const rayPointsBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, rayPointsBuffer);
const rayPointArray = new Float32Array(MAX_RAY_POINTS * 2);
gl.bufferData(gl.ARRAY_BUFFER, rayPointArray, gl.DYNAMIC_DRAW);

const simCornerBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, simCornerBuffer);
const simCorners = [
  0, 0,
  canvas.width, 0,
  0, canvas.height,
  canvas.width, canvas.height,
];
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(simCorners), gl.STATIC_DRAW);

const renderCornerBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, renderCornerBuffer);
const renderCorners = [
  0, 0,
  canvas.width, 0,
  0, canvas.height,
  canvas.width, canvas.height,
];
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(renderCorners), gl.STATIC_DRAW);

// create vertex arrays (records bindBuffer or vertexAttribPointer)
const rayVertexArray = gl.createVertexArray();
gl.bindVertexArray(rayVertexArray);
gl.bindBuffer(gl.ARRAY_BUFFER, rayPointsBuffer);
gl.vertexAttribPointer(rayPointsAttrLoc, 2, gl.FLOAT, false, 0, 0);
gl.enableVertexAttribArray(rayPointsAttrLoc);

const simVertexArray = gl.createVertexArray();
gl.bindVertexArray(simVertexArray);
gl.enableVertexAttribArray(simCornerAttrLoc);
gl.bindBuffer(gl.ARRAY_BUFFER, simCornerBuffer);
gl.vertexAttribPointer(simCornerAttrLoc, 2, gl.FLOAT, false, 0, 0);

const screenVertexArray = gl.createVertexArray();
gl.bindVertexArray(screenVertexArray);
gl.enableVertexAttribArray(renderCornerAttrLoc);
gl.bindBuffer(gl.ARRAY_BUFFER, renderCornerBuffer);
gl.vertexAttribPointer(renderCornerAttrLoc, 2, gl.FLOAT, false, 0, 0);

// main loop
let lastTime = performance.now();
function render() {
  if (!gl) return;
  requestAnimationFrame(render);
  // scale fade based on deltaTime
  const currentTime = performance.now();
  const deltaTime = currentTime - lastTime;
  lastTime = currentTime;
  // generate vectors for the cathode ray
  points.length = 0;
  lissajous(200, currentTime / 10000, 2, 3);
  // fade phosphor from PREV into CURR
  applyPhosphorFade(deltaTime);
  // draw the cathode ray segments for this frame
  applyCathodeRay(deltaTime);
  // render CURR to screen
  renderToScreen();

  // console.log(deltaTime|0, phosphorFade);
}
requestAnimationFrame(render);

function renderToScreen() {
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, renderFramebuffer);
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  gl.activeTexture(gl.TEXTURE0); // texture unit 0
  gl.bindTexture(gl.TEXTURE_2D, simTextures[CURR]);
  gl.useProgram(renderProgram);
  gl.uniform1i(renderTextureLoc, 0); // texture unit 0
  gl.uniform2f(renderResUniformLoc, gl.canvas.width, gl.canvas.height);
  gl.uniform1f(renderGammaUniformLoc, GAMMA);
  gl.bindVertexArray(screenVertexArray);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function applyPhosphorFade(deltaTime: number) {
  swapPrevAndCurrent();
  const phosphorFade = PHOSPHOR_FADE ** deltaTime;
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, simFramebuffer);
  gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, simTextures[CURR], 0);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.activeTexture(gl.TEXTURE0); // texture unit 0
  gl.bindTexture(gl.TEXTURE_2D, simTextures[PREV]);
  gl.useProgram(simProgram);
  gl.uniform1i(simTextureLoc, 0); // texture unit 0
  gl.uniform2f(simResUniformLoc, canvas.width, canvas.height);
  gl.uniform1f(simPhosphorFadeUniformLoc, phosphorFade);
  gl.bindVertexArray(simVertexArray);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// We draw a vector to the next positions as triangle strips.
// The length of the rectangle is proportional to
// the time it takes to draw, based on the speed of the cathode ray.
// TODO: * map texture onto the rectangle to have a Gaussian deposition of photons
//       * construct the strip from all vectors for this frame
const points: Position[] = [];
let cursor = 0;        // the index of the vector the ray is currently drawing
const center = { x: canvas.width / 2, y: canvas.height / 2 };
let rayPos = center;   // the current position of the ray
let numPoints = 0;     // the number of points the ray has drawn

function applyCathodeRay(ms: number) {
  beginSegments();
  let n = 0; // draw each point at most once per frame
  while (n++ < points.length && ms > 0 && numPoints+4 < MAX_RAY_POINTS) {
      const p = points[cursor] || center;     // next point to move to
      const dx = p.x - rayPos.x;
      const dy = p.y - rayPos.y;
      const distSq = dx * dx + dy * dy;
      // if the ray is at the point, move to the next point
      if (distSq < 1) {
          cursor = (cursor + 1) % points.length;
          continue
      }
      // otherwise move the ray towards the point
      const budget = RAY_SPEED * ms;
      const dist = Math.sqrt(distSq);
      const draw = Math.min(dist, budget);
      const time = draw / RAY_SPEED;
      const fraction = draw / dist;
      const nextPos = { x: rayPos.x + dx * fraction, y: rayPos.y + dy * fraction };
      appendSegment(rayPos, nextPos);
      rayPos = nextPos;
      ms -= time;
      // console.log(`segment #${cursor}: ${draw.toFixed()}/${dist.toFixed()}px (${(fraction*100).toFixed()}%, budget ${(budget).toFixed()}px), ${(time).toFixed(1)} ms, ${ms.toFixed(1)} ms left`);
  }
  // console.log(`frame: drew ${n} of ${points.length} pts starting at ${cursor}`);
  flushSegments();
}

function beginSegments() {
  // console.log('beginSegments');
  swapPrevAndCurrent();
  const w = canvas.width;
  const h = canvas.height;
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, simFramebuffer);
  gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, simTextures[CURR], 0);
  gl.viewport(0, 0, w, h);
  gl.activeTexture(gl.TEXTURE0); // texture unit 0
  gl.bindTexture(gl.TEXTURE_2D, simTextures[PREV]);
  gl.useProgram(rayProgram);
  gl.uniform1i(rayTextureLoc, 0); // texture unit 0
  gl.uniform2f(rayResUniformLoc, w, h);
  gl.uniform1i(rayTextureLoc, 0);
  // copy whole prev phosphor texture to current
  let p = 0;
  rayPointArray[p++] = 0; rayPointArray[p++] = 0;
  rayPointArray[p++] = w; rayPointArray[p++] = 0;
  rayPointArray[p++] = 0; rayPointArray[p++] = h;
  rayPointArray[p++] = h; rayPointArray[p++] = h;
  numPoints = 4;
}

function flushSegments() {
  // update buffer
  gl.bindVertexArray(rayVertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, rayPointsBuffer);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, rayPointArray, 0, numPoints * 2);
  gl.vertexAttribPointer(rayPointsAttrLoc, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(rayPointsAttrLoc);
  // draw phosphor texture
  gl.uniform3fv(rayPhotonsUniformLoc, [0, 0, 0]);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  // draw ray segments
  gl.uniform3fv(rayPhotonsUniformLoc, RAY_COLOR);
  gl.drawArrays(gl.TRIANGLE_STRIP, 4, numPoints - 4);
}

function appendSegment(prev: Position, next: Position) {
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return;
    const perpX = dy / dist * RAY_RADIUS;
    const perpY = -dx / dist * RAY_RADIUS;
    let p = numPoints * 2;
    if (isNaN(perpX) || isNaN(perpY) || isNaN(prev.x) || isNaN(prev.y) || isNaN(next.x) || isNaN(next.y)) {
      throw new Error('NaN');
    }
    rayPointArray[p++] = prev.x + perpX; rayPointArray[p++] = prev.y + perpY;
    rayPointArray[p++] = prev.x - perpX; rayPointArray[p++] = prev.y - perpY;
    rayPointArray[p++] = next.x + perpX; rayPointArray[p++] = next.y + perpY;
    rayPointArray[p++] = next.x - perpX; rayPointArray[p++] = next.y - perpY;
    numPoints += 4;
}

// test vectors
function lissajous(num = 200, phase=0, a=1, b=1) {
  const radius = { x: center.x * 0.9, y: center.y*0.9 };
  for (let i = 0; i < num; i++) {
    const angle = i * 2 * Math.PI / num;
    points.push({
      x: center.x + radius.x * Math.sin(a * angle + phase),
      y: center.y + radius.y * Math.sin(b * angle),
    });
  }
}


function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  const success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
  if (success) return shader;
  console.error(gl.getShaderInfoLog(shader));
  gl.deleteShader(shader);
}

function createProgram(gl, vertShader, fragShader) {
  const program = gl.createProgram();
  gl.attachShader(program, vertShader);
  gl.attachShader(program, fragShader);
  gl.linkProgram(program);
  const success = gl.getProgramParameter(program, gl.LINK_STATUS);
  if (success) return program;
  console.error(gl.getProgramInfoLog(program));
  gl.deleteProgram(program);
}

}