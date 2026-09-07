import type { AvatarReport } from '@coast/engine';
import type { AvatarDescriptor } from '../avatarStore';
import { AvatarApiError, avatarCapabilities, createAvatarJob, getAvatarJob, type AvatarJob, type AvatarProvider } from '../api';

type Submission = Parameters<typeof createAvatarJob>[1];
type Recovery = { submission: Submission; jobId?: string; unknown?: boolean };
const opaqueId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);

function generationInput(provider: string, prompt: string, image: string): Omit<Submission, 'requestId'> {
  if (provider === 'fal-meshy') {
    if (!prompt.trim() || prompt.length > 600) throw new Error('Enter a prompt of 1–600 characters.');
    return { provider, prompt: prompt.trim() };
  }
  if (provider !== 'fal-hunyuan') throw new Error('Select an available generation provider.');
  const value = image.trim();
  try {
    const url = new URL(value);
    if (
      value.length > 4096 ||
      /[\s\\]/.test(value) ||
      url.href.length > 4096 ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) ||
      /(^|\.)(localhost|local|internal|lan|home|test|invalid|example|onion|arpa|nip\.io|sslip\.io)$/.test(url.hostname)
    )
      throw new Error();
    return { provider, imageUrl: url.href };
  } catch {
    throw new Error('Enter a public HTTPS image URL (at most 4096 characters), without credentials, ports or fragments.');
  }
}

function readRecovery(value: string): Recovery {
  if (value.length > 8192) throw new Error();
  const saved = JSON.parse(value) as Recovery;
  if (
    !saved ||
    !saved.submission ||
    !opaqueId(saved.submission.requestId) ||
    (saved.jobId !== undefined && !opaqueId(saved.jobId)) ||
    (saved.unknown !== undefined && typeof saved.unknown !== 'boolean')
  )
    throw new Error();
  const input = generationInput(saved.submission.provider, saved.submission.prompt ?? '', saved.submission.imageUrl ?? '');
  return {
    submission: { ...input, requestId: saved.submission.requestId },
    ...(saved.jobId ? { jobId: saved.jobId } : {}),
    ...(saved.unknown ? { unknown: true } : {}),
  };
}

export interface AvatarCardOptions {
  sessionId: string;
  load(source: ArrayBuffer | string, name: string, forward: '-Z' | '+Z', save?: boolean): Promise<AvatarReport>;
  reset(): void | Promise<void>;
  library?: {
    list(): Promise<AvatarDescriptor[]>;
    select(id: string): Promise<AvatarReport>;
    remove(id: string): Promise<void>;
  };
  onOpenChange(open: boolean): void;
  capabilities?: typeof avatarCapabilities;
  create?: typeof createAvatarJob;
  poll?: typeof getAvatarJob;
}

export interface AvatarCard {
  el: HTMLElement;
  trigger: HTMLButtonElement;
  open(): void;
  close(): void;
  setCurrent(name: string, report: AvatarReport): void;
  dispose(): void;
}

const CSS = `
.coast-avatar-trigger{position:fixed;right:12px;top:82px;z-index:36}
.coast-avatar{position:fixed;inset:50% auto auto 50%;transform:translate(-50%,-50%);width:min(400px,calc(100vw - 40px));max-height:80vh;overflow:auto;z-index:100;padding:20px;background:#0b0a10;color:#f2ecdc;border:1px solid #ffb54a;border-radius:12px;font:14px system-ui,sans-serif;box-shadow:0 12px 60px #0009}
.coast-avatar[hidden]{display:none}.coast-avatar h2{margin:0 0 12px}.coast-avatar label{display:block;margin:12px 0 4px}.coast-avatar input:not([type=checkbox]),.coast-avatar select{box-sizing:border-box;width:100%;min-height:44px;background:#222129;color:inherit;border:1px solid #777;border-radius:5px;padding:8px;font:inherit}.coast-avatar input[type=checkbox]{width:20px;height:20px;vertical-align:middle}.coast-avatar button,.coast-avatar-trigger{min-height:44px;padding:8px 12px;border:1px solid #817965;background:#222129;color:#f2ecdc;border-radius:6px;font:14px system-ui,sans-serif;cursor:pointer}.coast-avatar button{margin:8px 8px 0 0}.coast-avatar button:disabled{opacity:.5;cursor:default}.coast-avatar :focus-visible,.coast-avatar-trigger:focus-visible{outline:2px solid #ffb54a;outline-offset:3px}.coast-avatar p{line-height:1.5}.coast-avatar .av-note{font-size:12px;color:#bcb5a7}
`;

export function createAvatarCard(parent: HTMLElement, opts: AvatarCardOptions): AvatarCard {
  const style = document.createElement('style');
  style.textContent = CSS;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'coast-avatar-trigger';
  trigger.textContent = 'Avatar · U';
  const el = document.createElement('section');
  el.className = 'coast-avatar';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Your avatar');
  el.innerHTML = `<h2>Your avatar</h2>
<p class="av-note">Optional. Files stay on this device; URL imports contact that host. Use a self-contained GLB up to 20 MiB. Unless saved, imported characters stay available until this page closes. Removing a saved file leaves currently loaded copies available until the page closes.</p>
<label>Upload GLB<input data-avatar="file" type="file" accept=".glb,model/gltf-binary"></label>
<label>GLB URL<input data-avatar="url" type="url" placeholder="https://…/character.glb"></label>
<label>Model faces<select data-avatar="forward"><option value="-Z">−Z (game forward)</option><option value="+Z">+Z (turn around)</option></select></label>
<label><input data-avatar="save" type="checkbox" aria-describedby="avatar-save-note"> Save on this device</label>
<p class="av-note" id="avatar-save-note">Opt in to keep the exact GLB from an upload, URL import or generated result locally on this device: up to 8 avatars / 128 MiB total. Saving does not upload anything or send input to a provider. Nothing is deleted automatically; remove saved avatars explicitly to make room. Browser storage may be unavailable or cleared.</p>
<button type="button" data-avatar="load">Use URL</button><button type="button" data-avatar="reset">Use mannequin</button>
<p data-avatar="status" role="status" aria-live="polite">Mannequin · procedural gait</p>
<label>Saved avatars<select data-avatar="saved"><option value="">No saved avatar selected</option></select></label>
<button type="button" data-avatar="use-saved" disabled>Use saved</button><button type="button" data-avatar="remove-saved" disabled>Remove saved</button>
<p class="av-note" data-avatar="library-status" role="status" aria-live="polite">Saved avatars are checked when opened. Nothing is loaded automatically.</p>
<details><summary>Generate a character</summary>
<p class="av-note" data-avatar="availability">Checking generation availability when opened. Upload and URL still work.</p>
<label>Source<select data-avatar="provider"><option value="tripo" disabled>Tripo · clip mapping pending</option><option value="fal-hunyuan">fal Hunyuan · image to figurine</option><option value="fal-meshy">fal Meshy · text to figurine</option></select></label>
<p class="av-note" data-avatar="retention">Pending request IDs, prompts and public image URLs are kept in this tab’s sessionStorage for reload recovery, then removed on completion. Do not enter secrets. Nothing is submitted or resumed automatically.</p>
<label>Prompt (Meshy only, 600 characters maximum)<input data-avatar="prompt" maxlength="600"></label>
<label>Public image URL (Hunyuan only)<input data-avatar="image" type="url" maxlength="4096" placeholder="https://…/reference.png"></label>
<label><input data-avatar="consent" type="checkbox"> Send this input to the selected provider and reserve up to $1.60 from this session’s budget.</label>
<p class="av-note" data-avatar="recovery"></p>
<button type="button" data-avatar="generate" disabled>Generate</button><button type="button" data-avatar="poll" disabled>Check existing job / use result</button>
</details>
<button type="button" data-avatar="close">Back to game</button>`;
  parent.append(style, trigger, el);
  const q = <T extends HTMLElement>(name: string) => el.querySelector<T>(`[data-avatar="${name}"]`)!;
  const status = q('status');
  const provider = q<HTMLSelectElement>('provider');
  const consent = q<HTMLInputElement>('consent');
  const generate = q<HTMLButtonElement>('generate');
  const poll = q<HTMLButtonElement>('poll');
  const sourceFile = q<HTMLInputElement>('file');
  const save = q<HTMLInputElement>('save');
  const saved = q<HTMLSelectElement>('saved');
  let descriptors: AvatarDescriptor[] = [];
  let libraryLoading = false;
  let libraryAvailable = false;
  let libraryGeneration = 0;
  let busy = false;
  let disposed = false;
  let generation = 0;
  let providers: Partial<Record<AvatarProvider, boolean>> = {};
  let job: AvatarJob | null = null;
  let recovery: Recovery | null = null;
  let storageBlocked = false;
  const storageKey = `coast:avatar:v1:${opts.sessionId}`;
  const storage = () => {
    const store = document.defaultView?.sessionStorage;
    if (!store) throw new Error();
    return store;
  };
  const storageWarning = () => {
    storageBlocked = true;
    q('retention').textContent =
      'Session recovery storage is unavailable or damaged. Generation is blocked to prevent duplicate charges. Upload and URL still work; do not clear storage to retry an uncertain job.';
  };
  const persist = () => {
    try {
      if (recovery) storage().setItem(storageKey, JSON.stringify(recovery));
      else storage().removeItem(storageKey);
      return true;
    } catch {
      storageWarning();
      return false;
    }
  };
  try {
    const saved = storage().getItem(storageKey);
    if (saved) {
      recovery = readRecovery(saved);
      provider.value = recovery.submission.provider;
      q<HTMLInputElement>('prompt').value = recovery.submission.prompt ?? '';
      q<HTMLInputElement>('image').value = recovery.submission.imageUrl ?? '';
    }
  } catch {
    storageWarning();
  }
  const sync = () => {
    const focused = document.activeElement;
    for (const key of ['load', 'reset', 'file', 'url', 'forward', 'save'] as const) {
      (q(key) as HTMLInputElement | HTMLButtonElement).disabled = busy;
    }
    saved.disabled = busy || libraryLoading || !libraryAvailable || !descriptors.length;
    for (const key of ['use-saved', 'remove-saved']) {
      q<HTMLButtonElement>(key).disabled = saved.disabled || !descriptors.some((entry) => entry.id === saved.value);
    }
    for (const key of ['provider', 'prompt', 'image'] as const) {
      (q(key) as HTMLInputElement).disabled = busy || !!recovery;
    }
    generate.disabled =
      busy ||
      storageBlocked ||
      !consent.checked ||
      !providers[provider.value as AvatarProvider] ||
      !!recovery?.jobId ||
      !!recovery?.unknown;
    generate.textContent = recovery ? 'Retry same submission' : 'Generate';
    poll.disabled = busy || !recovery;
    poll.textContent = job?.status === 'succeeded' && job.modelUrl ? 'Retry result import' : 'Check existing job / use result';
    q('recovery').textContent = recovery?.unknown
      ? 'Outcome unknown. Do not regenerate: a charge may already exist. Check the existing job or use a GLB instead.'
      : recovery?.jobId
        ? `Saved job ${recovery.jobId}. Check its status without creating another job.`
        : recovery
          ? `Submission ${recovery.submission.requestId} is unresolved. Check first; if no job is found, explicitly consent to retry the exact same submission. No new request ID will be used.`
          : '';
    if (!el.hidden && el.contains(focused) && focused?.matches(':disabled')) {
      q<HTMLButtonElement>('close').focus();
    }
  };
  sync();
  const refreshLibrary = async () => {
    if (disposed || el.hidden) return;
    const current = ++libraryGeneration;
    if (!opts.library) {
      q('library-status').textContent = 'Saved avatar library unavailable. Upload and URL still work.';
      return;
    }
    libraryLoading = true;
    sync();
    try {
      const entries = await opts.library.list();
      if (disposed || el.hidden || current !== libraryGeneration) return;
      const selected = saved.value;
      descriptors = entries;
      saved.replaceChildren();
      const placeholder = parent.ownerDocument.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Choose a saved avatar';
      saved.append(placeholder);
      for (const entry of entries) {
        const option = parent.ownerDocument.createElement('option');
        option.value = entry.id;
        option.textContent = entry.name;
        saved.append(option);
      }
      saved.value = entries.some((entry) => entry.id === selected) ? selected : '';
      libraryAvailable = true;
      q('library-status').textContent = entries.length
        ? `${entries.length} saved avatars. Choose one, then Use saved. No network import is needed.`
        : 'No saved avatars on this device. Upload and URL still work.';
    } catch (error) {
      if (disposed || el.hidden || current !== libraryGeneration) return;
      libraryAvailable = false;
      q('library-status').textContent =
        `Saved avatar library unavailable${error instanceof Error ? `: ${error.message}` : '.'} Your current character is unchanged. Upload and URL still work.`;
    } finally {
      if (current === libraryGeneration) {
        libraryLoading = false;
        if (!disposed) sync();
      }
    }
  };
  const run = async (task: (saveOnDevice: boolean) => Promise<void>) => {
    if (busy || disposed) return;
    busy = true;
    sync();
    try {
      await task(save.checked);
    } catch (error) {
      if (!disposed)
        status.textContent = `${error instanceof Error ? error.message : 'Avatar unavailable.'} Your current character is unchanged.`;
    } finally {
      busy = false;
      if (!disposed) sync();
    }
  };
  const showReport = (name: string, report: AvatarReport) => {
    if (disposed) return;
    const motion = report.clips.length
      ? report.clips.join(', ')
      : report.rig === 'mixamo'
        ? 'procedural gait'
        : 'figurine (no supported rig)';
    status.textContent = `${name} · ${report.boneCount} bones · ${report.triangles} triangles · ${report.heightM.toFixed(2)} m · ${motion}${report.warnings.length ? ` · ${report.warnings.join(' · ')}` : ''}`;
  };
  const importSource = async (source: ArrayBuffer | string, name: string, saveOnDevice: boolean) => {
    status.textContent = 'Inspecting character…';
    const forward = q<HTMLSelectElement>('forward').value as '-Z' | '+Z';
    const report = await (saveOnDevice ? opts.load(source, name, forward, true) : opts.load(source, name, forward));
    showReport(name, report);
    if (saveOnDevice) await refreshLibrary();
  };
  saved.addEventListener('change', sync);
  q('use-saved').addEventListener(
    'click',
    () =>
      void run(async () => {
        const entry = descriptors.find((item) => item.id === saved.value);
        if (!opts.library || !libraryAvailable || libraryLoading || !entry) return;
        const report = await opts.library.select(entry.id);
        showReport(entry.name, report);
        await refreshLibrary();
      }),
  );
  q('remove-saved').addEventListener(
    'click',
    () =>
      void run(async () => {
        const entry = descriptors.find((item) => item.id === saved.value);
        if (!opts.library || !libraryAvailable || libraryLoading || !entry) return;
        if (
          !parent.ownerDocument.defaultView?.confirm(
            `Remove saved avatar "${entry.name}"? Saved takes may require reimport of this exact GLB.`,
          )
        )
          return;
        await opts.library.remove(entry.id);
        if (!disposed) status.textContent = `Removed saved avatar: ${entry.name}. Saved takes may require reimport of this exact GLB.`;
        await refreshLibrary();
      }),
  );
  const clearRecovery = () => {
    job = null;
    recovery = null;
    consent.checked = false;
    persist();
  };
  const updateJob = async (next: AvatarJob, saveOnDevice: boolean) => {
    if (disposed || !recovery) return;
    if (!next || !opaqueId(next.id) || !['queued', 'running', 'succeeded', 'failed', 'unknown'].includes(next.status)) {
      throw new Error('Invalid job response. Check the existing submission; do not generate another.');
    }
    job = next;
    recovery.jobId = next.id;
    recovery.unknown = next.status === 'unknown';
    persist();
    status.textContent = `Character job ${next.id}: ${next.status}${next.error ? ` · ${next.error}` : ''}`;
    if (next.status === 'succeeded') {
      if (!next.modelUrl) throw new Error('Job succeeded but its model is unavailable. Check again; do not regenerate.');
      await importSource(next.modelUrl, 'Generated character', saveOnDevice);
      if (!disposed) clearRecovery();
    } else if (next.status === 'failed') clearRecovery();
  };
  sourceFile.addEventListener(
    'change',
    () =>
      void run(async (saveOnDevice) => {
        const file = sourceFile.files?.[0];
        if (!file) return;
        try {
          if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('GLB must be nonempty and at most 20 MiB.');
          if (!/\.glb$/i.test(file.name)) throw new Error('Choose a self-contained .glb file.');
          const bytes = await file.arrayBuffer();
          if (!disposed) await importSource(bytes, file.name, saveOnDevice);
        } finally {
          sourceFile.value = '';
        }
      }),
  );
  q('load').addEventListener(
    'click',
    () =>
      void run(async (saveOnDevice) => {
        const url = q<HTMLInputElement>('url').value.trim();
        if (!url) throw new Error('Enter a GLB URL first.');
        await importSource(url, nameOfUrl(url), saveOnDevice);
      }),
  );
  q('reset').addEventListener(
    'click',
    () =>
      void run(async () => {
        await opts.reset();
        if (!disposed) status.textContent = 'Mannequin · procedural gait';
      }),
  );
  generate.addEventListener(
    'click',
    () =>
      void run(async (saveOnDevice) => {
        if (!consent.checked || storageBlocked || !providers[provider.value as AvatarProvider] || recovery?.jobId || recovery?.unknown)
          return;
        if (!recovery) {
          const input = generationInput(provider.value, q<HTMLInputElement>('prompt').value, q<HTMLInputElement>('image').value);
          recovery = { submission: { ...input, requestId: crypto.randomUUID() } };
          if (!persist()) {
            recovery = null;
            throw new Error('Cannot safely save this request. No generation was submitted.');
          }
        }
        consent.checked = false;
        status.textContent = 'Submitting once; recovery uses the same request ID…';
        let next: AvatarJob;
        try {
          next = await (opts.create ?? createAvatarJob)(opts.sessionId, recovery.submission);
        } catch (error) {
          if (disposed) return;
          if (error instanceof AvatarApiError && [400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(error.status)) {
            clearRecovery();
            throw error;
          }
          throw new Error(
            'Submission outcome is uncertain. Check the existing job first; any explicit retry will reuse the saved input and request ID.',
            { cause: error },
          );
        }
        await updateJob(next, saveOnDevice);
      }),
  );
  poll.addEventListener(
    'click',
    () =>
      void run(async (saveOnDevice) => {
        if (!recovery) return;
        if (job?.status === 'succeeded' && job.modelUrl) {
          await updateJob(job, saveOnDevice);
          return;
        }
        try {
          await updateJob(await (opts.poll ?? getAvatarJob)(opts.sessionId, recovery.jobId ?? recovery.submission.requestId), saveOnDevice);
        } catch (error) {
          if (error instanceof AvatarApiError && error.status === 404) {
            throw new Error(
              'No job found for this ID. The submission remains unresolved; do not start a new request. Only an explicit same-ID retry can recover a submission without a known job ID.',
              { cause: error },
            );
          }
          throw error;
        }
      }),
  );
  for (const key of ['provider', 'prompt', 'image']) {
    q(key).addEventListener(key === 'provider' ? 'change' : 'input', () => {
      consent.checked = false;
      sync();
    });
  }
  consent.addEventListener('change', sync);
  const close = () => {
    if (el.hidden) return;
    el.hidden = true;
    consent.checked = false;
    sync();
    generation++;
    libraryGeneration++;
    libraryLoading = false;
    opts.onOpenChange(false);
    trigger.focus();
  };
  const open = () => {
    if (!el.hidden || disposed) return;
    el.hidden = false;
    opts.onOpenChange(true);
    q<HTMLButtonElement>('close').focus();
    const current = ++generation;
    providers = {};
    sync();
    void refreshLibrary();
    void Promise.resolve()
      .then(() => (opts.capabilities ?? avatarCapabilities)())
      .then((caps) => {
        if (disposed || current !== generation) return;
        providers = { ...caps.providers, tripo: false };
        for (const option of Array.from(provider.options)) option.disabled = !providers[option.value as AvatarProvider];
        if (!recovery && !providers[provider.value as AvatarProvider])
          provider.value = Object.keys(providers).find((key) => key !== 'tripo' && providers[key as AvatarProvider]) ?? 'fal-hunyuan';
        q('availability').textContent = Object.values(providers).some(Boolean)
          ? 'Generation uses the Worker’s budget gate. Meshy results are unrigged figurines. Tripo clip mapping and Hunyuan mesh reduction are pending.'
          : 'Generation unavailable: provider keys or a supported adapter are not configured. Upload and URL still work.';
        sync();
      })
      .catch(() => {
        if (disposed || current !== generation) return;
        q('availability').textContent = 'Generation unavailable: the Worker is offline. Upload and URL still work.';
      });
  };
  trigger.addEventListener('click', open);
  q('close').addEventListener('click', close);
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      el.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary'),
    ).filter((node) => !node.closest('details:not([open])') || node.tagName === 'SUMMARY');
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  return {
    el,
    trigger,
    open,
    close,
    setCurrent: showReport,
    dispose() {
      close();
      disposed = true;
      generation++;
      el.remove();
      trigger.remove();
      style.remove();
    },
  };
}

export function nameOfUrl(value: string): string {
  try {
    return decodeURIComponent(new URL(value, 'https://local.invalid').pathname.split('/').pop() || 'Imported character').slice(0, 120);
  } catch {
    return 'Imported character';
  }
}
