import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { type AvatarAsset, type AvatarOptions, disposeAvatarResources } from './avatar';
import { prepareAvatar, validateAvatarOptions } from './prepareAvatar';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const sizeError = () => new Error('Avatar GLB exceeds the 20 MB size limit.');

function avatarURL(source: string): string {
  if (!source.trim() || source.length > 4096) throw new Error('Invalid avatar URL.');
  const base = typeof location !== 'undefined' ? location.href : undefined;
  let url: URL;
  try {
    url = new URL(source, base);
  } catch {
    throw new Error('Avatar URL must be absolute HTTPS or same-origin relative.');
  }
  if (url.username || url.password) throw new Error('Avatar URL must not contain credentials.');
  const relative = !/^[a-z][a-z\d+.-]*:/i.test(source) && !source.startsWith('//');
  const sameOriginRelative = relative && base && url.origin === new URL(base).origin;
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || sameOriginRelative)))
    throw new Error('Avatar URL requires HTTPS, HTTP loopback, or a same-origin relative URL.');
  return url.href;
}

async function fetchAvatar(source: string): Promise<ArrayBuffer> {
  const url = avatarURL(source);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'error',
      mode: 'cors',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error(`Avatar download failed (HTTP ${response.status}).`);
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > MAX_BYTES) {
      controller.abort();
      throw sizeError();
    }
    if (!response.body) throw new Error('Avatar download has no readable body.');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > MAX_BYTES) {
        controller.abort();
        throw sizeError();
      }
      chunks.push(result.value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return buffer.buffer;
  } finally {
    clearTimeout(timeout);
    if (reader) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

type GLBJson = {
  asset?: { version?: string };
  scenes?: unknown[];
  nodes?: { children?: number[] }[];
  images?: { bufferView: number; mimeType: string }[];
  animations?: unknown[];
  accessors?: { count: number; type: string; componentType: number }[];
  buffers?: { byteLength: number; extensions?: { EXT_meshopt_compression?: { fallback?: boolean } } }[];
  bufferViews?: {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    extensions?: {
      EXT_meshopt_compression?: { buffer: number; byteOffset?: number; byteLength: number; count: number; byteStride: number };
    };
  }[];
  skins?: { joints: number[] }[];
};

function imagePixels(bytes: Uint8Array, mime: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0,
    height = 0;
  if (mime === 'image/png' && bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(12) === 0x49484452) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (mime === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 9 < bytes.length;) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) break;
      const marker = view.getUint8(offset++);
      if (offset + 7 > bytes.length || marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (mime === 'image/webp' && bytes.length >= 30 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    const kind = view.getUint32(12);
    if (kind === 0x56503858) {
      width = 1 + view.getUint8(24) + (view.getUint8(25) << 8) + (view.getUint8(26) << 16);
      height = 1 + view.getUint8(27) + (view.getUint8(28) << 8) + (view.getUint8(29) << 16);
    } else if (kind === 0x56503820 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    } else if (kind === 0x5650384c && bytes[20] === 0x2f) {
      const packed = view.getUint32(21, true);
      width = 1 + (packed & 0x3fff);
      height = 1 + ((packed >>> 14) & 0x3fff);
    }
  }
  if (width < 1 || height < 1 || width > 4096 || height > 4096)
    throw new Error('Avatar texture is invalid or exceeds 4096 pixels per side. Embed valid PNG/JPEG/WebP textures.');
  return width * height;
}

function inspectGLB(data: ArrayBuffer): void {
  if (data.byteLength > MAX_BYTES) throw sizeError();
  if (data.byteLength < 20) throw new Error('Invalid GLB: file is too short.');
  const view = new DataView(data);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== data.byteLength)
    throw new Error('Invalid GLB v2 header or length.');
  let json: GLBJson | undefined;
  let binaryBytes = 0;
  let binaryOffset = 0;
  for (let offset = 12; offset < data.byteLength;) {
    if (offset + 8 > data.byteLength) throw new Error('Invalid GLB chunk header.');
    const length = view.getUint32(offset, true),
      type = view.getUint32(offset + 4, true);
    if (length % 4 || offset + 8 + length > data.byteLength) throw new Error('Invalid GLB chunk length.');
    if (offset === 12 && type !== 0x4e4f534a) throw new Error('Invalid GLB: first chunk must be JSON.');
    if (type === 0x4e4f534a) {
      if (json || length > 4 * 1024 * 1024) throw new Error('Invalid GLB JSON chunk (maximum 4 MB).');
      try {
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(data, offset + 8, length))) as GLBJson;
      } catch {
        throw new Error('Invalid GLB JSON.');
      }
    } else if (type === 0x004e4942) {
      if (binaryBytes) throw new Error('Invalid GLB: multiple binary chunks.');
      binaryBytes = length;
      binaryOffset = offset + 8;
    }
    offset += 8 + length;
  }
  if (!json || json.asset?.version !== '2.0') throw new Error('Invalid GLB: glTF 2.0 asset required.');
  const scan = (value: unknown, depth: number) => {
    if (depth > 32) throw new Error('Invalid GLB: JSON nesting limit exceeded.');
    if (typeof value === 'string') {
      if (value === 'KHR_draco_mesh_compression')
        throw new Error('Draco avatars are unsupported. Re-export GLB without Draco (meshopt is supported).');
      if (value === 'KHR_texture_basisu' || value === 'image/ktx2')
        throw new Error('KTX2 avatars need a renderer-specific transcoder. Re-export this GLB with embedded PNG/JPEG/WebP textures.');
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'uri')
          throw new Error(
            'Avatar must be a self-contained GLB: external and data URI subresources are not allowed. Embed buffers and images in the binary chunk.',
          );
        scan(key, depth + 1);
        scan(child, depth + 1);
      }
    }
  };
  scan(json, 0);
  const arrays = ['scenes', 'nodes', 'images', 'animations', 'accessors', 'buffers', 'bufferViews', 'skins'] as const;
  for (const key of arrays) if (json[key] !== undefined && !Array.isArray(json[key])) throw new Error(`Invalid GLB ${key}.`);
  if (
    (json.nodes?.length ?? 0) > 2048 ||
    (json.animations?.length ?? 0) > 128 ||
    (json.accessors?.length ?? 0) > 4096 ||
    (json.bufferViews?.length ?? 0) > 4096 ||
    (json.scenes?.length ?? 0) > 8
  )
    throw new Error('Avatar GLB exceeds scene/animation structure limits.');
  if ((json.scenes?.length ?? 0) > 1) throw new Error('Avatar GLB must contain a single scene; export only the character scene.');
  const integer = (value: number, max = MAX_DECODED_BYTES) => Number.isSafeInteger(value) && value >= 0 && value <= max;
  const visited = new Set<number>(),
    visiting = new Set<number>(),
    parented = new Set<number>();
  const visit = (index: number, depth: number) => {
    if (!integer(index, (json.nodes?.length ?? 0) - 1) || visiting.has(index) || depth > 128)
      throw new Error('Invalid GLB node hierarchy (cycle, depth or node index).');
    if (visited.has(index)) return;
    const node = json.nodes![index];
    if (!node || (node.children !== undefined && !Array.isArray(node.children))) throw new Error('Invalid GLB node children.');
    visiting.add(index);
    for (const child of node.children ?? []) {
      if (parented.has(child)) throw new Error('Invalid GLB node hierarchy: multiple parents.');
      parented.add(child);
      visit(child, depth + 1);
    }
    visiting.delete(index);
    visited.add(index);
  };
  for (let i = 0; i < (json.nodes?.length ?? 0); i++) visit(i, 0);
  if ((json.buffers?.length ?? 0) > 2) throw new Error('Avatar requires one embedded buffer and at most one meshopt fallback buffer.');
  for (const [index, buffer] of (json.buffers ?? []).entries()) {
    const fallback = buffer?.extensions?.EXT_meshopt_compression?.fallback === true;
    if (!buffer || (index > 0 && !fallback) || !integer(buffer.byteLength, fallback ? MAX_DECODED_BYTES : binaryBytes))
      throw new Error('Invalid GLB buffer size or non-embedded buffer.');
  }
  let decodedBytes = 0;
  for (const bufferView of json.bufferViews ?? []) {
    if (
      !bufferView ||
      !integer(bufferView.buffer, (json.buffers?.length ?? 0) - 1) ||
      !integer(bufferView.byteOffset ?? 0) ||
      !integer(bufferView.byteLength) ||
      (bufferView.byteOffset ?? 0) + bufferView.byteLength > (json.buffers?.[bufferView.buffer]?.byteLength ?? 0)
    )
      throw new Error('Invalid GLB buffer view bounds.');
    const meshopt = bufferView.extensions?.EXT_meshopt_compression;
    const fallback = json.buffers?.[bufferView.buffer]?.extensions?.EXT_meshopt_compression?.fallback === true;
    if (fallback && !meshopt) throw new Error('Invalid GLB: fallback buffer view requires meshopt data.');
    const bytes = meshopt ? meshopt.count * meshopt.byteStride : bufferView.byteLength;
    if (!integer(bytes)) throw new Error('Avatar meshopt decoded buffer exceeds 64 MB.');
    if (
      meshopt &&
      (meshopt.buffer !== 0 ||
        !integer(meshopt.count, 1_000_000) ||
        !integer(meshopt.byteStride, 256) ||
        meshopt.byteStride < 1 ||
        !integer(meshopt.byteOffset ?? 0) ||
        !integer(meshopt.byteLength, binaryBytes) ||
        (meshopt.byteOffset ?? 0) + meshopt.byteLength > binaryBytes ||
        bytes !== bufferView.byteLength)
    )
      throw new Error('Invalid GLB meshopt buffer bounds.');
    decodedBytes += bytes;
  }
  if (decodedBytes > MAX_DECODED_BYTES) throw new Error('Avatar decoded buffers exceed 64 MB.');
  if ((json.images?.length ?? 0) > 32) throw new Error('Avatar exceeds the 32 embedded texture limit.');
  let pixels = 0;
  for (const image of json.images ?? []) {
    if (!image || !integer(image.bufferView, (json.bufferViews?.length ?? 0) - 1)) throw new Error('Invalid GLB embedded image.');
    const bufferView = json.bufferViews![image.bufferView]!;
    if (bufferView.buffer !== 0 || bufferView.extensions?.EXT_meshopt_compression)
      throw new Error('Avatar images must be embedded directly in the GLB binary buffer.');
    pixels += imagePixels(new Uint8Array(data, binaryOffset + (bufferView.byteOffset ?? 0), bufferView.byteLength), image.mimeType);
  }
  if (pixels > 32 * 1024 * 1024) throw new Error('Avatar textures exceed the 32 megapixel decoded image limit.');
  let accessorBytes = 0;
  for (const accessor of json.accessors ?? []) {
    if (!accessor || !integer(accessor.count, 1_000_000)) throw new Error('Invalid GLB accessor count.');
    const components = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 } as Record<string, number>)[accessor.type];
    if (typeof components !== 'number' || ![5120, 5121, 5122, 5123, 5125, 5126].includes(accessor.componentType))
      throw new Error('Invalid GLB accessor format.');
    accessorBytes += accessor.count * components * 4;
  }
  if (accessorBytes > MAX_DECODED_BYTES) throw new Error('Avatar decoded accessors exceed 64 MB.');
  const joints = new Set<number>();
  for (const skin of json.skins ?? []) {
    if (!skin || !Array.isArray(skin.joints) || skin.joints.length > 80)
      throw new Error('Avatar exceeds the 80 bone limit or has invalid joints.');
    for (const joint of skin.joints) {
      if (!integer(joint, (json.nodes?.length ?? 0) - 1)) throw new Error('Invalid GLB skeleton joint.');
      joints.add(joint);
    }
  }
  if (joints.size > 80) throw new Error('Avatar exceeds the 80 bone limit.');
}

export async function readAvatarBytes(source: ArrayBuffer | string): Promise<ArrayBuffer> {
  if (!(source instanceof ArrayBuffer) && typeof source !== 'string') throw new Error('Avatar source must be GLB bytes or a URL.');
  if (source instanceof ArrayBuffer && source.byteLength > MAX_BYTES) throw sizeError();
  const data = typeof source === 'string' ? await fetchAvatar(source) : source.slice(0);
  inspectGLB(data);
  return data;
}

export async function loadAvatar(source: ArrayBuffer | string, opts: AvatarOptions): Promise<AvatarAsset> {
  validateAvatarOptions(opts);
  const data = await readAvatarBytes(source);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (!url.startsWith('blob:')) throw new Error('Avatar must be a self-contained GLB; subresource fetch blocked.');
    return url;
  });
  const loader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(data, '');
  try {
    return prepareAvatar(gltf.scene, gltf.animations, opts);
  } catch (error) {
    disposeAvatarResources(gltf.scene);
    throw error;
  }
}
