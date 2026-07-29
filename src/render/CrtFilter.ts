import { Filter, GlProgram, UniformGroup, defaultFilterVert } from 'pixi.js'

/**
 * CRT post-processing, ported from streetalien's `src/fx/crt.ts`.
 *
 * That version is a Canvas 2D present pass - sliced barrel warp, additive
 * ghost blits, a downscaled bloom buffer, a pre-rendered scanline/grille
 * canvas, then gradient overlays. None of that compositing survives a move to
 * WebGL, so this is the same chain of effects expressed as one fragment
 * shader, in the same order and with the same constants:
 *
 *   barrel curvature -> convergence ghosting -> bloom -> scanlines +
 *   aperture grille -> rolling band -> vignette -> flicker -> tube mask
 *
 * The original's "crush to half res" step is deliberately dropped: this game
 * already renders at an integer zoom with nearest-neighbour sampling, so its
 * pixels are chunky before the CRT ever sees them.
 *
 * All tuning constants are in the original's 960x540 present space. `uPixelScale`
 * converts one of those units into device pixels, so the effect stays the same
 * apparent size at any window size.
 */

const fragment = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
// Pixi hands filters a texture from a pool that is usually larger than the
// area being filtered, so vTextureCoord does NOT span 0..1 across the screen.
// uInputClamp.zw is where the real content ends; everything here works in
// "frame space" (0..1 over the visible area) and converts on the way to a
// texture read.
uniform vec4 uInputClamp;
uniform float uTime;
uniform float uPixelScale;
uniform float uGridPeriod;
uniform float uGlow;
uniform float uIntensity;
uniform vec2 uScreenSize;
uniform float uBrightness;
uniform float uContrast;

// --- constants, in the original's 960x540 present space ---
const float CURVE          = 9.0;    // px the image is squeezed at the edges
const float TUBE_INSET     = 4.0;
const float TUBE_RADIUS    = 26.0;
const float GHOST_ALPHA    = 0.12;
const float GHOST_OFFSET   = 2.0;
const float BLOOM_ALPHA    = 0.32;
const float BLOOM_RADIUS   = 4.0;
const float SCAN_PERIOD    = 3.0;
const float SCAN_DARK      = 0.28;
const float GRILLE_ALPHA   = 0.045;
const float GRILLE_ALPHA_B = 0.055;
const float BAND_HEIGHT    = 140.0;
const float BAND_SPEED     = 42.0;
const float BAND_ALPHA     = 0.045;
const float VIGNETTE_INNER = 0.45;
const float VIGNETTE_OUTER = 0.95;
const float VIGNETTE_ALPHA = 0.5;

vec3 sampleScene(vec2 frameUv) {
    // Outside the tube there is nothing behind the glass.
    if (frameUv.x < 0.0 || frameUv.x > 1.0 || frameUv.y < 0.0 || frameUv.y > 1.0) return vec3(0.0);
    vec2 uv = clamp(frameUv * uInputClamp.zw, uInputClamp.xy, uInputClamp.zw);
    return texture(uTexture, uv).rgb;
}

void main() {
    vec2 uv = vTextureCoord / uInputClamp.zw;
    vec2 size = uScreenSize;
    float px = uPixelScale;

    // --- barrel curvature -------------------------------------------------
    // The original draws 60 vertical slices, each squeezed vertically by
    // curve * nx^2. Continuous here, but the same shape.
    float nx = uv.x * 2.0 - 1.0;
    float squeeze = (CURVE * px / size.y) * nx * nx;
    vec2 warped = vec2(uv.x, (uv.y - squeeze) / max(1.0 - 2.0 * squeeze, 0.0001));

    vec3 color = sampleScene(warped);

    // --- convergence error ------------------------------------------------
    // Two faint copies, shifted horizontally, added on top.
    // uGlow scales both additive passes together: they are the same physical
    // thing - light from one part of the tube landing on another - and pulling
    // them apart just gives two sliders that have to be kept in agreement.
    vec2 ghost = vec2(GHOST_OFFSET * px, 0.0) / size;
    color += GHOST_ALPHA * uGlow * sampleScene(warped - ghost);
    color += GHOST_ALPHA * uGlow * sampleScene(warped + vec2(ghost.x, -px / size.y));

    // --- phosphor bloom ---------------------------------------------------
    // Stands in for the original's quarter-res buffer drawn back additively.
    vec2 radius = vec2(BLOOM_RADIUS * px) / size;
    vec3 bloom = vec3(0.0);
    for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.7853981634; // 2pi / 8
        bloom += sampleScene(warped + vec2(cos(a), sin(a)) * radius);
    }
    color += (bloom / 8.0) * BLOOM_ALPHA * uGlow;

    // Everything on the glass - the shadow mask, the beam's own scanlines, the
    // rolling band - lives on the curved surface, so it is measured in the
    // *warped* frame rather than the flat one. Using uv here left the grid
    // dead straight over a picture that bends, which reads immediately as
    // wrong. As a bonus this is also the space the game's pixels are square
    // in, so the grid stays locked to them across the whole tube.
    vec2 frag = warped * size;

    // --- scanlines --------------------------------------------------------
    // uGridPeriod is one game pixel (see crtGridPeriod), so this is one
    // scanline per source row - what a tube actually draws - with the beam
    // gap taking the bottom third of each. Sizing it from uPixelScale instead
    // makes the bands beat against the pixels and crawl.
    float row = floor(fract(frag.y / uGridPeriod) * SCAN_PERIOD);
    if (row >= SCAN_PERIOD - 1.0) color *= 1.0 - SCAN_DARK;

    // --- aperture grille --------------------------------------------------
    // One red-green-blue triad per game pixel, for the same reason.
    float col = floor(fract(frag.x / uGridPeriod) * SCAN_PERIOD);
    vec3 tint = col < 1.0 ? vec3(1.0, 0.235, 0.235)
              : col < 2.0 ? vec3(0.235, 1.0, 0.235)
                          : vec3(0.235, 0.235, 1.0);
    float grilleAlpha = col < 2.0 ? GRILLE_ALPHA : GRILLE_ALPHA_B;
    color = mix(color, tint, grilleAlpha);

    // --- slow rolling band ------------------------------------------------
    float bandSpan = size.y + 160.0 * px;
    float bandY = mod(uTime * BAND_SPEED * px, bandSpan) - 160.0 * px;
    float band = 1.0 - abs(frag.y - (bandY + BAND_HEIGHT * px * 0.5)) / (BAND_HEIGHT * px * 0.5);
    color += vec3(BAND_ALPHA * max(band, 0.0));

    // --- vignette ---------------------------------------------------------
    vec2 fromCentre = frag - size * 0.5;
    float dist = length(fromCentre) / size.y;
    float vig = smoothstep(VIGNETTE_INNER, VIGNETTE_OUTER, dist);
    color *= 1.0 - vig * VIGNETTE_ALPHA;

    // --- flicker ----------------------------------------------------------
    float flicker = 0.03 * sin(uTime * 87.0) + 0.015 * sin(uTime * 311.0);
    color *= 1.0 - max(0.0, flicker + 0.02);

    // --- rounded tube mask ------------------------------------------------
    // 'half' is a reserved word in GLSL - do not name this that.
    vec2 tubeHalf = size * 0.5 - vec2(TUBE_INSET * px);
    vec2 d = abs(fromCentre) - (tubeHalf - vec2(TUBE_RADIUS * px));
    float tube = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - TUBE_RADIUS * px;
    color *= 1.0 - smoothstep(-1.0, 1.0, tube);

    color = mix(sampleScene(uv), color, uIntensity);

    // --- brightness / contrast --------------------------------------------
    // Applied last, and outside the intensity mix, so it also corrects the
    // raw image when the CRT pass is dialled off. The additive ghost and
    // bloom passes lift the blacks noticeably on this game's dark art; this
    // is the knob that pulls them back.
    color *= uBrightness;
    color = (color - 0.5) * uContrast + 0.5;

    finalColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`

export interface CrtOptions {
  /** Device pixels per unit of the original 960x540 present space. */
  pixelScale?: number
  gridPeriod?: number
  /** Multiplies the bloom and convergence ghosting. 1 is the authored amount. */
  glow?: number
  /** 0 = untouched, 1 = full effect. */
  intensity?: number
  /** 1 = unchanged. Applied after the CRT pass. */
  brightness?: number
  /** 1 = unchanged, pivoting around mid grey. Applied after the CRT pass. */
  contrast?: number
}

export class CrtFilter extends Filter {
  constructor(options: CrtOptions = {}) {
    const uniforms = new UniformGroup({
      uTime: { value: 0, type: 'f32' },
      uPixelScale: { value: options.pixelScale ?? 2, type: 'f32' },
      uGridPeriod: { value: options.gridPeriod ?? 6, type: 'f32' },
      uGlow: { value: options.glow ?? 1, type: 'f32' },
      uIntensity: { value: options.intensity ?? 1, type: 'f32' },
      uScreenSize: { value: new Float32Array([960, 540]), type: 'vec2<f32>' },
      uBrightness: { value: options.brightness ?? 1.2, type: 'f32' },
      uContrast: { value: options.contrast ?? 1.2, type: 'f32' },
    })

    super({
      glProgram: GlProgram.from({
        vertex: defaultFilterVert,
        fragment,
        name: 'crt-filter',
      }),
      resources: { crtUniforms: uniforms },
      // The pass is screen-space; padding would shift the tube mask.
      padding: 0,
      resolution: 1,
    })
  }

  private get uniforms() {
    return (this.resources.crtUniforms as UniformGroup).uniforms as {
      uTime: number
      uPixelScale: number
      uGridPeriod: number
      uGlow: number
      uIntensity: number
      uScreenSize: Float32Array
      uBrightness: number
      uContrast: number
    }
  }

  /** Seconds since start; drives the rolling band and flicker. */
  set time(value: number) {
    this.uniforms.uTime = value
  }

  set pixelScale(value: number) {
    this.uniforms.uPixelScale = value
  }

  /** Screen-space size of one scanline/grille cycle. See `crtGridPeriod`. */
  set gridPeriod(value: number) {
    this.uniforms.uGridPeriod = value
  }

  /**
   * How much bloom and convergence ghosting to add. 1 is the amount the
   * original effect was authored with; 0 leaves the picture sharp.
   */
  get glow(): number {
    return this.uniforms.uGlow
  }

  set glow(value: number) {
    this.uniforms.uGlow = value
  }

  /** Size of the filtered area in device pixels. */
  setScreenSize(width: number, height: number): void {
    this.uniforms.uScreenSize[0] = width
    this.uniforms.uScreenSize[1] = height
  }

  get intensity(): number {
    return this.uniforms.uIntensity
  }

  set intensity(value: number) {
    this.uniforms.uIntensity = value
  }

  get brightness(): number {
    return this.uniforms.uBrightness
  }

  set brightness(value: number) {
    this.uniforms.uBrightness = value
  }

  get contrast(): number {
    return this.uniforms.uContrast
  }

  set contrast(value: number) {
    this.uniforms.uContrast = value
  }
}

/** Matches the original's look: its constants were authored against 540px tall. */
export function crtPixelScale(screenHeight: number): number {
  return Math.max(1, screenHeight / 540)
}

/**
 * Screen-space period of one scanline and grille cycle.
 *
 * The rest of the pass is authored against a 960x540 buffer and scaled by
 * `crtPixelScale`, but the grid cannot be. A cycle that is not a whole number
 * of game pixels beats against them - band edges land part-way into a pixel,
 * a different part of it each row, and the scanlines crawl.
 *
 * The target is one cycle per game pixel, because that is what a tube does:
 * one scanline per source row, one shadow-mask triad per source pixel. An
 * earlier version made a whole game pixel the *cell* rather than the cycle,
 * which is aligned but three times too coarse - it darkened one row in three
 * of the game's own pixels and looked like a venetian blind.
 *
 * A cycle is three cells, so it needs at least three device pixels to draw at
 * all. Below zoom 3 a game pixel is smaller than that and the mask would
 * dissolve into flat grey, so the cycle grows to the next whole number of
 * game pixels that fits. Coarser than ideal, but still locked to the grid,
 * and the alternative at those sizes is no CRT at all.
 *
 * `zoom` is the integer scale the world is drawn at, so it is exactly one
 * game pixel; `resolution` converts that to device pixels.
 */
export function crtGridPeriod(zoom: number, resolution = 1): number {
  const devicePixelsPerCycle = zoom * resolution
  return zoom * Math.max(1, Math.ceil(3 / devicePixelsPerCycle))
}
