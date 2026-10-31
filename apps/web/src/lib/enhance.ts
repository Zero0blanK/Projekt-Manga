/**
 * Settings › Reader › Enhance low-resolution pages: a 2× upscale with contrast-adaptive
 * sharpening (the approach of AMD FidelityFX CAS, which supports upscaling), run on the GPU
 * through WebGL2. No model file and nothing leaves the device. Line art comes out crisper
 * than the browser's own scaling without the halos of a plain unsharp mask.
 *
 * Only pages smaller than they're shown are enhanced, and anything that can't run (no
 * WebGL2, a page whose pixels can't be read) shows the original.
 */

export const READER_ENHANCE = 'readerEnhance';

/** The enhanced side never goes past this, so a large scan can't exhaust GPU memory. */
const MAX_SIDE = 4096;
const CACHE_LIMIT = 40;

/**
 * Whether a page is worth enhancing: it is shown larger than its own pixels. `shownWidth` is
 * in CSS pixels and `dpr` the screen's device-pixel ratio.
 */
export function shouldEnhance(
  naturalWidth: number,
  naturalHeight: number,
  shownWidth: number,
  dpr = 1,
): boolean {
  if (naturalWidth <= 0 || naturalHeight <= 0 || shownWidth <= 0) return false;
  if (naturalWidth * 2 > MAX_SIDE || naturalHeight * 2 > MAX_SIDE) return false;
  return naturalWidth < shownWidth * dpr * 0.95;
}

const VERTEX = `#version 300 es
in vec2 position;
out vec2 uv;
void main() {
  uv = position * 0.5 + 0.5;
  uv.y = 1.0 - uv.y;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

// Contrast-adaptive sharpening over a bilinear 2x upscale. Sampling the source at output
// pixel offsets gives the 3x3 neighbourhood; the sharpening weight shrinks where the local
// contrast is already high, which is what keeps it from ringing around ink lines.
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D image;
uniform vec2 step;
uniform float sharpness;
in vec2 uv;
out vec4 color;
void main() {
  vec3 a = texture(image, uv + vec2(-step.x, -step.y)).rgb;
  vec3 b = texture(image, uv + vec2(0.0, -step.y)).rgb;
  vec3 c = texture(image, uv + vec2(step.x, -step.y)).rgb;
  vec3 d = texture(image, uv + vec2(-step.x, 0.0)).rgb;
  vec3 e = texture(image, uv).rgb;
  vec3 f = texture(image, uv + vec2(step.x, 0.0)).rgb;
  vec3 g = texture(image, uv + vec2(-step.x, step.y)).rgb;
  vec3 h = texture(image, uv + vec2(0.0, step.y)).rgb;
  vec3 i = texture(image, uv + vec2(step.x, step.y)).rgb;
  vec3 mn = min(min(min(d, e), min(f, b)), h);
  vec3 mx = max(max(max(d, e), max(f, b)), h);
  mn += min(min(min(a, c), min(g, i)), mn);
  mx += max(max(max(a, c), max(g, i)), mx);
  vec3 amp = sqrt(clamp(min(mn, 2.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
  vec3 w = amp * (-1.0 / mix(8.0, 5.0, sharpness));
  vec3 sharpened = ((b + d + f + h) * w + e) / (1.0 + 4.0 * w);
  color = vec4(clamp(sharpened, 0.0, 1.0), 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('shader');
  return shader;
}

/** Renders the enhanced page to a blob, or null when WebGL2 can't. */
async function render(img: HTMLImageElement): Promise<Blob | null> {
  const width = img.naturalWidth * 2;
  const height = img.naturalHeight * 2;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext('webgl2', {
    preserveDrawingBuffer: true,
    premultipliedAlpha: false,
  });
  if (!gl) return null;
  try {
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Throws for a cross-origin image the server didn't allow: the page stays as it is.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

    gl.uniform1i(gl.getUniformLocation(program, 'image'), 0);
    // One output pixel, in the source's texture coordinates.
    gl.uniform2f(gl.getUniformLocation(program, 'step'), 1 / width, 1 / height);
    gl.uniform1f(gl.getUniformLocation(program, 'sharpness'), 0.6);
    gl.viewport(0, 0, width, height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (gl.getError() !== gl.NO_ERROR) return null;
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.95));
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

const cache = new Map<string, Promise<string | null>>();

/**
 * An object URL of the enhanced page, cached by the page's URL, or null to keep showing
 * the original. The oldest cached pages are released as new ones come in.
 */
export function enhancedPageUrl(img: HTMLImageElement): Promise<string | null> {
  const key = img.currentSrc || img.src;
  const cached = cache.get(key);
  if (cached) return cached;
  const job = render(img)
    .then((blob) => (blob ? URL.createObjectURL(blob) : null))
    .catch(() => null);
  cache.set(key, job);
  if (cache.size > CACHE_LIMIT) {
    const [oldestKey, oldest] = cache.entries().next().value!;
    cache.delete(oldestKey);
    void oldest.then((url) => url && URL.revokeObjectURL(url));
  }
  return job;
}
