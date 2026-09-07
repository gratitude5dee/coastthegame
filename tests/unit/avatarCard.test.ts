import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { createAvatarCard, type AvatarCard, type AvatarCardOptions } from '../../apps/web/src/ui/avatarCard';
import type { AvatarDescriptor } from '../../apps/web/src/avatarStore';
import { AvatarApiError, createAvatarJob } from '../../apps/web/src/api';

const report = { boneCount: 20, triangles: 240, heightM: 1.8, clips: [], rig: 'mixamo' as const, warnings: [] };
const storageKey = 'coast:avatar:v1:session-123';
let window: Window;
let fetchMock: ReturnType<typeof vi.fn>;
let confirmMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  window = new Window({ url: 'https://coast.invalid' });
  vi.stubGlobal('document', window.document);
  confirmMock = vi.fn().mockReturnValue(false);
  Object.defineProperty(window, 'confirm', { value: confirmMock, configurable: true });
  fetchMock = vi.fn().mockRejectedValue(new Error('Unexpected network call'));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  window.happyDOM.abort();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const q = <T extends HTMLElement = HTMLButtonElement>(card: AvatarCard, key: string) => card.el.querySelector<T>(`[data-avatar="${key}"]`)!;
const setup = (enabled = false, sessionId = 'session-123', library?: AvatarCardOptions['library']) => {
  const load = vi.fn().mockResolvedValue(report);
  const reset = vi.fn();
  const onOpenChange = vi.fn();
  const capabilities = vi.fn().mockResolvedValue({ providers: { tripo: false, 'fal-hunyuan': enabled, 'fal-meshy': enabled } });
  const create = vi.fn().mockResolvedValue({ id: 'job-123456', status: 'queued' });
  const poll = vi.fn().mockResolvedValue({ id: 'job-123456', status: 'running' });
  const card = createAvatarCard(document.body, {
    sessionId,
    load,
    reset,
    onOpenChange,
    capabilities,
    create,
    poll,
    ...(library ? { library } : {}),
  });
  return { card, load, reset, onOpenChange, capabilities, create, poll };
};
const descriptor: AvatarDescriptor = { id: 'saved-avatar-1', name: 'Saved dancer.glb', forward: '+Z', heightM: 1.8, bytes: 12 };
const setupLibrary = (entries: AvatarDescriptor[] = [descriptor]) => {
  const library = {
    list: vi.fn().mockResolvedValue(entries),
    select: vi.fn().mockResolvedValue(report),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  return { ...setup(true, 'session-123', library), library };
};
const chooseSaved = (card: AvatarCard, id = descriptor.id) => {
  q<HTMLSelectElement>(card, 'saved').value = id;
  q(card, 'saved').dispatchEvent(new window.Event('change') as unknown as Event);
};
const consent = (card: AvatarCard) => {
  q<HTMLInputElement>(card, 'consent').checked = true;
  q(card, 'consent').dispatchEvent(new window.Event('change') as unknown as Event);
};
const prepare = async (card: AvatarCard, provider = 'fal-meshy', value = 'A stylized dancer') => {
  card.open();
  await flush();
  card.el.querySelector('details')!.open = true;
  q<HTMLSelectElement>(card, 'provider').value = provider;
  q(card, 'provider').dispatchEvent(new window.Event('change') as unknown as Event);
  q<HTMLInputElement>(card, provider === 'fal-meshy' ? 'prompt' : 'image').value = value;
  consent(card);
};
const submit = async (card: AvatarCard) => {
  q(card, 'generate').click();
  await flush();
};

describe('Avatar card (CAP-1)', () => {
  it('reflects an avatar restored outside the card without opening or saving it', () => {
    const { card, load } = setup();
    card.setCurrent('Restored performer', { ...report, rig: 'unrigged' });
    expect(card.el.hidden).toBe(true);
    expect(q(card, 'status').textContent).toContain('Restored performer');
    expect(q(card, 'status').textContent).toContain('figurine');
    expect(load).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is optional and does not check capabilities until opened', async () => {
    const { card, onOpenChange, capabilities } = setup();
    await flush();
    expect(capabilities).not.toHaveBeenCalled();
    expect(card.el.hidden).toBe(true);
    card.trigger.click();
    await flush();
    expect(card.el.hidden).toBe(false);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(card.el.textContent).toContain('Upload and URL still work');
    expect(q(card, 'generate').disabled).toBe(true);
    card.close();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).toBe(card.trigger);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps uploads and URL imports available when capabilities are offline', async () => {
    const { card, capabilities, load } = setup(true);
    capabilities.mockRejectedValue(new Error('Offline'));
    card.open();
    await flush();
    expect(card.el.textContent).toContain('Worker is offline');
    expect(q(card, 'file').disabled).toBe(false);
    q<HTMLInputElement>(card, 'url').value = 'https://assets.example/avatar.glb';
    q(card, 'load').click();
    await flush();
    expect(load).toHaveBeenCalledOnce();
    expect(q(card, 'generate').disabled).toBe(true);
  });

  it('imports a URL on request and renders hostile filenames and warnings as text', async () => {
    const { card, load } = setup();
    load.mockResolvedValue({ ...report, warnings: ['<img src=x onerror=alert(1)>'] });
    card.open();
    q<HTMLInputElement>(card, 'url').value = 'https://assets.example/%3Csvg%20onload=alert(1)%3E.glb';
    expect(load).not.toHaveBeenCalled();
    q(card, 'load').click();
    await flush();
    expect(load).toHaveBeenCalledWith(q<HTMLInputElement>(card, 'url').value, '<svg onload=alert(1)>.glb', '-Z');
    expect(card.el.textContent).toContain('20 bones');
    expect(card.el.textContent).toContain('procedural gait');
    expect(card.el.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(card.el.querySelector('svg, img')).toBeNull();
    card.dispose();
    expect(card.el.isConnected).toBe(false);
    expect(card.trigger.isConnected).toBe(false);
  });

  it('keeps recovery controls available after an import error', async () => {
    const { card, load, reset } = setup();
    load.mockRejectedValueOnce(new Error('Not a GLB'));
    card.open();
    q<HTMLInputElement>(card, 'url').value = 'https://assets.example/broken.glb';
    q(card, 'load').click();
    await flush();
    expect(card.el.textContent).toContain('Not a GLB');
    expect(q(card, 'load').disabled).toBe(false);
    q(card, 'reset').click();
    await flush();
    expect(reset).toHaveBeenCalledOnce();
  });

  it('requires explicit consent with a configured provider and revokes it on input edits', async () => {
    const { card, create } = setup(true);
    await prepare(card);
    q<HTMLInputElement>(card, 'prompt').value = 'Edited dancer';
    q(card, 'prompt').dispatchEvent(new window.Event('input') as unknown as Event);
    await submit(card);
    expect(create).not.toHaveBeenCalled();
    consent(card);
    await submit(card);
    expect(create).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['', '   ', 'x'.repeat(601)])('rejects invalid prompts before reserving a request: %j', async (prompt) => {
    const { card, create } = setup(true);
    await prepare(card, 'fal-meshy', prompt);
    await submit(card);
    expect(create).not.toHaveBeenCalled();
    expect(card.el.textContent).toContain('1–600');
    expect(q(card, 'prompt').disabled).toBe(false);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    q<HTMLInputElement>(card, 'prompt').value = 'A valid dancer';
    consent(card);
    await submit(card);
    expect(create).toHaveBeenCalledOnce();
  });

  it.each([
    '',
    'http://images.coast.net/a.png',
    'https://localhost/a.png',
    'https://127.0.0.1/a.png',
    'https://private.internal/a.png',
    'https://x.nip.io/a.png',
    'https://user:secret@images.coast.net/a.png',
    'https://images.coast.net:123/a.png',
    'https://images.coast.net/a.png#secret',
    'https://images.coast.net/a\\b.png',
    'https://images.coast.net/' + 'a'.repeat(4096),
  ])('rejects unsafe image URLs before generation: %j', async (url) => {
    const { card, create } = setup(true);
    await prepare(card, 'fal-hunyuan', url);
    await submit(card);
    expect(create).not.toHaveBeenCalled();
    expect(card.el.textContent).toContain('public HTTPS image URL');
    expect(q(card, 'image').disabled).toBe(false);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });

  it('submits only the selected provider input and imports a successful result', async () => {
    const { card, create, poll, load } = setup(true);
    await prepare(card, 'fal-hunyuan', ' https://images.coast.net/avatar.png ');
    q<HTMLInputElement>(card, 'prompt').value = 'Unused prompt';
    await submit(card);
    expect(create).toHaveBeenCalledWith('session-123', {
      provider: 'fal-hunyuan',
      imageUrl: 'https://images.coast.net/avatar.png',
      requestId: expect.any(String),
    });
    expect(load).not.toHaveBeenCalled();
    poll.mockResolvedValue({ id: 'job-123456', status: 'succeeded', modelUrl: 'https://assets.example/generated.glb' });
    q(card, 'poll').click();
    await flush();
    expect(load).toHaveBeenCalledWith('https://assets.example/generated.glb', 'Generated character', '-Z');
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(q<HTMLInputElement>(card, 'consent').checked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([400, 401, 402, 403, 413, 422, 429])('releases definitively rejected input after HTTP %i', async (status) => {
    const { card, create } = setup(true);
    create.mockRejectedValueOnce(new AvatarApiError(status, 'Rejected input'));
    await prepare(card);
    await submit(card);
    const first = create.mock.calls[0]![1].requestId;
    expect(q(card, 'prompt').disabled).toBe(false);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    q<HTMLInputElement>(card, 'prompt').value = 'A corrected dancer';
    consent(card);
    await submit(card);
    expect(create.mock.calls[1]![1].requestId).not.toBe(first);
  });

  it.each([new Error('Offline'), new AvatarApiError(503, 'Unavailable'), new AvatarApiError(409, 'Conflict')])(
    'preserves an ambiguous submission for explicit same-ID recovery',
    async (error) => {
      const first = setup(true);
      first.create.mockRejectedValue(error);
      await prepare(first.card);
      await submit(first.card);
      const input = first.create.mock.calls[0]![1];
      expect(q(first.card, 'prompt').disabled).toBe(true);
      first.card.dispose();
      const resumed = setup(true);
      await prepare(resumed.card);
      q<HTMLInputElement>(resumed.card, 'consent').checked = false;
      q(resumed.card, 'consent').dispatchEvent(new window.Event('change') as unknown as Event);
      expect(resumed.create).not.toHaveBeenCalled();
      expect(resumed.poll).not.toHaveBeenCalled();
      resumed.poll.mockRejectedValue(new AvatarApiError(404, 'Not found'));
      q(resumed.card, 'poll').click();
      await flush();
      expect(resumed.poll).toHaveBeenCalledWith('session-123', input.requestId);
      expect(resumed.create).not.toHaveBeenCalled();
      consent(resumed.card);
      await submit(resumed.card);
      expect(resumed.create).toHaveBeenCalledWith('session-123', input);
    },
  );

  it('restores a known pending job across reload with a read only and no consent or create', async () => {
    const first = setup(true);
    await prepare(first.card);
    await submit(first.card);
    const saved = JSON.parse(window.sessionStorage.getItem(storageKey)!);
    expect(Object.keys(saved).sort()).toEqual(['jobId', 'submission', 'unknown']);
    expect(saved.submission.prompt).toBe('A stylized dancer');
    first.card.dispose();
    const resumed = setup(true);
    resumed.card.open();
    await flush();
    expect(resumed.create).not.toHaveBeenCalled();
    expect(resumed.poll).not.toHaveBeenCalled();
    expect(q<HTMLInputElement>(resumed.card, 'consent').checked).toBe(false);
    q(resumed.card, 'poll').click();
    await flush();
    expect(resumed.poll).toHaveBeenCalledWith('session-123', 'job-123456');
    expect(resumed.create).not.toHaveBeenCalled();
    const other = setup(true, 'session-456');
    expect(q(other.card, 'poll').disabled).toBe(true);
  });

  it('retries a generated model import without polling or generating again', async () => {
    const { card, create, poll, load } = setup(true);
    create.mockResolvedValue({ id: 'job-123456', status: 'succeeded', modelUrl: 'https://assets.example/generated.glb' });
    load.mockRejectedValueOnce(new Error('Temporary import failure'));
    await prepare(card);
    await submit(card);
    expect(card.el.textContent).toContain('Temporary import failure');
    expect(q(card, 'poll').textContent).toBe('Retry result import');
    expect(window.sessionStorage.getItem(storageKey)).not.toContain('modelUrl');
    q(card, 'poll').click();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledOnce();
    expect(poll).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });

  it('retains terminal unknown across reload and never permits blind regeneration', async () => {
    const first = setup(true);
    first.create.mockResolvedValue({ id: 'job-123456', status: 'unknown', error: '<img src=x>' });
    await prepare(first.card);
    await submit(first.card);
    expect(first.card.el.querySelector('img')).toBeNull();
    first.card.dispose();
    const resumed = setup(true);
    await prepare(resumed.card);
    expect(resumed.card.el.textContent).toContain('Outcome unknown');
    expect(q(resumed.card, 'generate').disabled).toBe(true);
    expect(q(resumed.card, 'poll').disabled).toBe(false);
    expect(q(resumed.card, 'file').disabled).toBe(false);
    await submit(resumed.card);
    expect(resumed.create).not.toHaveBeenCalled();
  });

  it('releases a failed job but requires fresh consent before a new generation', async () => {
    const { card, create } = setup(true);
    create.mockResolvedValue({ id: 'job-123456', status: 'failed', error: 'Provider rejected generation' });
    await prepare(card);
    await submit(card);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(q(card, 'prompt').disabled).toBe(false);
    expect(q(card, 'generate').disabled).toBe(true);
  });

  it('fails closed on corrupt recovery storage without disabling uploads', async () => {
    window.sessionStorage.setItem(storageKey, '{broken');
    const { card, create } = setup(true);
    await prepare(card);
    await submit(card);
    expect(create).not.toHaveBeenCalled();
    expect(card.el.textContent).toContain('storage is unavailable or damaged');
    expect(q(card, 'file').disabled).toBe(false);
  });

  it('does not submit when persistence fails', async () => {
    const { card, create } = setup(true);
    vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('Quota');
    });
    await prepare(card);
    await submit(card);
    expect(create).not.toHaveBeenCalled();
    expect(q(card, 'file').disabled).toBe(false);
    expect(card.el.textContent).toContain('No generation was submitted');
  });

  it('traps focus, permits closing during submission and ignores late results after disposal', async () => {
    const { card, create, onOpenChange, load } = setup(true);
    let resolve!: (value: unknown) => void;
    create.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await prepare(card);
    q(card, 'close').focus();
    q(card, 'close').dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }) as unknown as Event,
    );
    expect(document.activeElement).toBe(q(card, 'file'));
    q(card, 'file').dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }) as unknown as Event,
    );
    expect(document.activeElement).toBe(q(card, 'close'));
    q(card, 'generate').focus();
    q(card, 'generate').click();
    q(card, 'generate').click();
    expect(document.activeElement).toBe(q(card, 'close'));
    expect(create).toHaveBeenCalledOnce();
    expect(q(card, 'close').disabled).toBe(false);
    q(card, 'close').dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }) as unknown as Event,
    );
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).toBe(card.trigger);
    card.dispose();
    resolve({ id: 'job-123456', status: 'succeeded', modelUrl: 'https://assets.example/avatar.glb' });
    await flush();
    expect(load).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(storageKey)).not.toBeNull();
  });

  it('retains the pre-submit request through a reload before the response arrives', async () => {
    const first = setup(true);
    first.create.mockImplementation(() => new Promise(() => {}));
    await prepare(first.card);
    q(first.card, 'generate').click();
    const input = first.create.mock.calls[0]![1];
    expect(JSON.parse(window.sessionStorage.getItem(storageKey)!).submission).toEqual(input);
    first.card.dispose();
    const resumed = setup(true);
    resumed.card.open();
    await flush();
    expect(q<HTMLInputElement>(resumed.card, 'prompt').value).toBe(input.prompt);
    expect(q<HTMLInputElement>(resumed.card, 'consent').checked).toBe(false);
    expect(resumed.create).not.toHaveBeenCalled();
    q(resumed.card, 'poll').click();
    await flush();
    expect(resumed.poll).toHaveBeenCalledWith('session-123', input.requestId);
    expect(resumed.create).not.toHaveBeenCalled();
  });

  it('handles denied storage reads and leaves local import available', async () => {
    vi.spyOn(window.sessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('Denied');
    });
    const { card, create } = setup(true);
    await prepare(card);
    await submit(card);
    expect(create).not.toHaveBeenCalled();
    expect(q(card, 'file').disabled).toBe(false);
    expect(q(card, 'load').disabled).toBe(false);
  });

  it('imports a local GLB without network and clears the file selector after rejection', async () => {
    const { card, load } = setup();
    card.open();
    const file = q<HTMLInputElement>(card, 'file');
    const bytes = new ArrayBuffer(12);
    const arrayBuffer = vi.fn().mockResolvedValue(bytes);
    Object.defineProperty(file, 'files', { configurable: true, value: [{ name: 'avatar.glb', size: 12, arrayBuffer }] });
    file.dispatchEvent(new window.Event('change') as unknown as Event);
    await flush();
    expect(load).toHaveBeenCalledWith(bytes, 'avatar.glb', '-Z');
    Object.defineProperty(file, 'files', { value: [{ name: 'huge.glb', size: 21 * 1024 * 1024, arrayBuffer }] });
    file.dispatchEvent(new window.Event('change') as unknown as Event);
    await flush();
    expect(arrayBuffer).toHaveBeenCalledOnce();
    expect(file.value).toBe('');
    expect(file.disabled).toBe(false);
    expect(card.el.textContent).toContain('at most 20 MiB');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, true])('passes the local save opt-in only to URL imports: %s', async (save) => {
    const { card, load, library } = setupLibrary();
    card.open();
    await flush();
    expect(q<HTMLInputElement>(card, 'save').checked).toBe(false);
    expect(card.el.textContent).toContain('exact GLB');
    expect(card.el.textContent).toContain('8 avatars / 128 MiB');
    expect(card.el.textContent).toContain('Saving does not upload anything or send input to a provider');
    q<HTMLInputElement>(card, 'save').checked = save;
    q<HTMLInputElement>(card, 'url').value = 'https://assets.example/dancer.glb';
    q<HTMLSelectElement>(card, 'forward').value = '+Z';
    q(card, 'load').click();
    await flush();
    expect(load.mock.calls).toEqual([['https://assets.example/dancer.glb', 'dancer.glb', '+Z', ...(save ? [true] : [])]]);
    expect(library.list).toHaveBeenCalledTimes(save ? 2 : 1);
    expect(library.remove).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, true])('captures upload save consent before reading the file: %s', async (save) => {
    const { card, load } = setupLibrary();
    card.open();
    await flush();
    q<HTMLInputElement>(card, 'save').checked = save;
    const bytes = new ArrayBuffer(12);
    let resolve!: (value: ArrayBuffer) => void;
    const arrayBuffer = vi.fn(
      () =>
        new Promise<ArrayBuffer>((done) => {
          resolve = done;
        }),
    );
    Object.defineProperty(q(card, 'file'), 'files', { value: [{ name: 'local.glb', size: 12, arrayBuffer }] });
    q(card, 'file').dispatchEvent(new window.Event('change') as unknown as Event);
    expect(q(card, 'save').disabled).toBe(true);
    q(card, 'save').click();
    expect(q<HTMLInputElement>(card, 'save').checked).toBe(save);
    card.close();
    card.open();
    await flush();
    resolve(bytes);
    await flush();
    expect(load.mock.calls).toEqual([[bytes, 'local.glb', '-Z', ...(save ? [true] : [])]]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps save opt-in independent from provider consent and out of recovery storage and requests', async () => {
    const { card, create, poll, load, library } = setupLibrary();
    await prepare(card);
    q<HTMLInputElement>(card, 'consent').checked = false;
    q(card, 'consent').dispatchEvent(new window.Event('change') as unknown as Event);
    q(card, 'save').click();
    await submit(card);
    expect(create).not.toHaveBeenCalled();
    consent(card);
    await submit(card);
    expect(create).toHaveBeenCalledWith('session-123', {
      provider: 'fal-meshy',
      prompt: 'A stylized dancer',
      requestId: expect.any(String),
    });
    expect(window.sessionStorage.getItem(storageKey)).not.toContain('save');
    expect(q<HTMLInputElement>(card, 'save').checked).toBe(true);
    poll.mockResolvedValue({ id: 'job-123456', status: 'succeeded', modelUrl: 'https://assets.example/result.glb' });
    q(card, 'poll').click();
    await flush();
    expect(load).toHaveBeenCalledWith('https://assets.example/result.glb', 'Generated character', '-Z', true);
    expect(library.list).toHaveBeenCalledTimes(2);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes the library only on open and explicit actions, never loads on selection change', async () => {
    const { card, library, load, create, poll } = setupLibrary();
    await flush();
    expect(library.list).not.toHaveBeenCalled();
    card.open();
    await flush();
    expect(library.list).toHaveBeenCalledOnce();
    expect(q(card, 'use-saved').disabled).toBe(true);
    chooseSaved(card);
    await flush();
    expect(library.select).not.toHaveBeenCalled();
    expect(library.list).toHaveBeenCalledOnce();
    expect(q(card, 'use-saved').disabled).toBe(false);
    q<HTMLSelectElement>(card, 'forward').value = '-Z';
    q(card, 'use-saved').click();
    await flush();
    expect(library.select).toHaveBeenCalledWith(descriptor.id);
    expect(q(card, 'status').textContent).toContain(`${descriptor.name} · 20 bones`);
    expect(library.list).toHaveBeenCalledTimes(2);
    expect(q<HTMLSelectElement>(card, 'saved').value).toBe(descriptor.id);
    card.close();
    await flush();
    expect(library.list).toHaveBeenCalledTimes(2);
    card.open();
    await flush();
    expect(library.list).toHaveBeenCalledTimes(3);
    expect(library.select).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(poll).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders hostile saved labels as text and confirms the exact target before removing', async () => {
    const hostile = { ...descriptor, name: '<img src=x onerror=alert(1)> "dancer"' };
    const { card, library, load, reset } = setupLibrary([hostile]);
    card.open();
    await flush();
    chooseSaved(card);
    expect(q<HTMLSelectElement>(card, 'saved').selectedOptions[0]!.textContent).toBe(hostile.name);
    expect(card.el.querySelector('img')).toBeNull();
    q(card, 'remove-saved').click();
    await flush();
    expect(confirmMock).toHaveBeenCalledWith(`Remove saved avatar "${hostile.name}"? Saved takes may require reimport of this exact GLB.`);
    expect(library.remove).not.toHaveBeenCalled();
    expect(library.list).toHaveBeenCalledOnce();
    expect(q<HTMLSelectElement>(card, 'saved').value).toBe(hostile.id);
    confirmMock.mockReturnValue(true);
    library.list.mockResolvedValue([]);
    q(card, 'remove-saved').click();
    await flush();
    expect(library.remove).toHaveBeenCalledOnce();
    expect(library.remove).toHaveBeenCalledWith(hostile.id);
    expect(library.list).toHaveBeenCalledTimes(2);
    expect(q(card, 'use-saved').disabled).toBe(true);
    expect(q(card, 'remove-saved').disabled).toBe(true);
    expect(q(card, 'status').textContent).toContain(hostile.name);
    expect(card.el.querySelector('img')).toBeNull();
    expect(reset).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['Quota exceeded: 8 avatars / 128 MiB', 'Storage blocked', 'Saved GLB missing'])(
    'keeps imports usable after a library list failure: %s',
    async (message) => {
      const { card, library, load } = setupLibrary();
      library.list.mockRejectedValue(new Error(message));
      card.open();
      await flush();
      expect(q(card, 'library-status').textContent).toContain(message);
      expect(q(card, 'library-status').textContent).toContain('Your current character is unchanged');
      for (const key of ['file', 'url', 'load', 'save', 'reset']) expect(q(card, key).disabled).toBe(false);
      expect(q(card, 'use-saved').disabled).toBe(true);
      q<HTMLInputElement>(card, 'url').value = 'https://assets.example/import.glb';
      q(card, 'load').click();
      await flush();
      expect(load).toHaveBeenCalledWith('https://assets.example/import.glb', 'import.glb', '-Z');
      expect(library.remove).not.toHaveBeenCalled();
      expect(library.select).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('warns about an absent library without breaking the backwards-compatible import callbacks', async () => {
    const { card, load } = setup();
    card.open();
    await flush();
    expect(q(card, 'library-status').textContent).toContain('library unavailable');
    expect(q(card, 'file').disabled).toBe(false);
    expect(q(card, 'load').disabled).toBe(false);
    expect(q(card, 'use-saved').disabled).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });

  it.each(['Saved on this device.', 'Save failed: quota exceeded; available for this page only.'])(
    'shows the game-provided save outcome without deleting anything: %s',
    async (warning) => {
      const { card, load, library } = setupLibrary();
      card.open();
      await flush();
      load.mockResolvedValue({ ...report, warnings: [warning] });
      q<HTMLInputElement>(card, 'save').checked = true;
      q<HTMLInputElement>(card, 'url').value = 'https://assets.example/import.glb';
      q(card, 'load').click();
      await flush();
      expect(q(card, 'status').textContent).toContain(warning);
      expect(q(card, 'status').textContent).toContain('20 bones');
      expect(library.remove).not.toHaveBeenCalled();
      expect(library.list).toHaveBeenCalledTimes(2);
      expect(q(card, 'load').disabled).toBe(false);
    },
  );

  it.each(['use-saved', 'remove-saved'])('retains the current asset and library selection after %s fails', async (action) => {
    const { card, library, reset, load } = setupLibrary();
    card.open();
    await flush();
    chooseSaved(card);
    confirmMock.mockReturnValue(true);
    library.select.mockRejectedValue(new Error('Saved GLB missing'));
    library.remove.mockRejectedValue(new Error('Storage blocked'));
    q(card, action).click();
    await flush();
    expect(q(card, 'status').textContent).toContain('Your current character is unchanged');
    expect(q<HTMLSelectElement>(card, 'saved').value).toBe(descriptor.id);
    expect(q(card, 'use-saved').disabled).toBe(false);
    expect(q(card, 'file').disabled).toBe(false);
    expect(q(card, 'load').disabled).toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(library.list).toHaveBeenCalledOnce();
  });

  it('awaits resetting a saved current avatar and locks all new controls without losing close focus', async () => {
    const { card, library, reset } = setupLibrary();
    card.open();
    await flush();
    chooseSaved(card);
    q(card, 'use-saved').click();
    await flush();
    expect(library.select).toHaveBeenCalledOnce();
    let resolve!: () => void;
    reset.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    q(card, 'reset').focus();
    q(card, 'reset').click();
    expect(q(card, 'status').textContent).toContain(descriptor.name);
    for (const key of ['saved', 'use-saved', 'remove-saved', 'save', 'file', 'load', 'reset']) expect(q(card, key).disabled).toBe(true);
    expect(document.activeElement).toBe(q(card, 'close'));
    card.close();
    expect(document.activeElement).toBe(card.trigger);
    resolve();
    await flush();
    expect(q(card, 'status').textContent).toBe('Mannequin · procedural gait');
    expect(reset).toHaveBeenCalledOnce();
    expect(library.remove).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(card.trigger);
  });

  it('does not let late library refreshes cancel an import or overwrite a newer list', async () => {
    const { card, library, load } = setupLibrary();
    let resolveList!: (value: AvatarDescriptor[]) => void;
    library.list.mockImplementationOnce(
      () =>
        new Promise<AvatarDescriptor[]>((done) => {
          resolveList = done;
        }),
    );
    let resolveLoad!: (value: typeof report) => void;
    load.mockImplementationOnce(
      () =>
        new Promise<typeof report>((done) => {
          resolveLoad = done;
        }),
    );
    card.open();
    expect(q(card, 'file').disabled).toBe(false);
    q<HTMLInputElement>(card, 'url').value = 'https://assets.example/current.glb';
    q(card, 'load').click();
    card.close();
    card.open();
    await flush();
    resolveList([{ ...descriptor, id: 'stale', name: 'Stale' }]);
    resolveLoad(report);
    await flush();
    expect(q(card, 'status').textContent).toContain('current.glb · 20 bones');
    expect(q(card, 'saved').textContent).toContain(descriptor.name);
    expect(q(card, 'saved').textContent).not.toContain('Stale');
    expect(q(card, 'load').disabled).toBe(false);
    expect(load).toHaveBeenCalledOnce();
  });

  it.each(['use-saved', 'remove-saved'])('locks all new controls during pending %s and permits closing', async (action) => {
    const { card, library, load, reset } = setupLibrary();
    card.open();
    await flush();
    chooseSaved(card);
    confirmMock.mockReturnValue(true);
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    library.select.mockImplementation(() => pending.then(() => report));
    library.remove.mockImplementation(() => pending);
    q(card, action).focus();
    q(card, action).click();
    for (const key of ['saved', 'use-saved', 'remove-saved', 'save', 'file', 'load', 'reset']) expect(q(card, key).disabled).toBe(true);
    q(card, action).click();
    q(card, 'reset').click();
    expect(document.activeElement).toBe(q(card, 'close'));
    card.close();
    expect(document.activeElement).toBe(card.trigger);
    resolve();
    await flush();
    expect(library[action === 'use-saved' ? 'select' : 'remove']).toHaveBeenCalledOnce();
    expect(library.list).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(card.trigger);
    card.open();
    await flush();
    expect(library.list).toHaveBeenCalledTimes(2);
    expect(q(card, 'save').disabled).toBe(false);
  });

  it('finishes a generated saved import after closing without regenerating or refreshing a hidden list', async () => {
    const { card, create, load, poll, library } = setupLibrary();
    let resolve!: (value: unknown) => void;
    create.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await prepare(card);
    q(card, 'save').click();
    q(card, 'generate').click();
    expect(q(card, 'save').disabled).toBe(true);
    q(card, 'save').click();
    expect(q<HTMLInputElement>(card, 'save').checked).toBe(true);
    card.close();
    resolve({ id: 'job-123456', status: 'succeeded', modelUrl: 'https://assets.example/generated.glb' });
    await flush();
    expect(load).toHaveBeenCalledWith('https://assets.example/generated.glb', 'Generated character', '-Z', true);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(create).toHaveBeenCalledOnce();
    expect(poll).not.toHaveBeenCalled();
    expect(library.list).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(card.trigger);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not replace a successful saved import report when refreshing the library fails', async () => {
    const { card, load, library } = setupLibrary();
    card.open();
    await flush();
    load.mockResolvedValue({ ...report, warnings: ['Saved on this device.'] });
    library.list.mockRejectedValue(new Error('Storage blocked'));
    q(card, 'save').click();
    q<HTMLInputElement>(card, 'url').value = 'https://assets.example/saved.glb';
    q(card, 'load').click();
    await flush();
    expect(q(card, 'status').textContent).toContain('saved.glb · 20 bones');
    expect(q(card, 'status').textContent).toContain('Saved on this device.');
    expect(q(card, 'library-status').textContent).toContain('Storage blocked');
    expect(q(card, 'load').disabled).toBe(false);
    expect(q(card, 'file').disabled).toBe(false);
    expect(library.remove).not.toHaveBeenCalled();
  });

  it('exposes typed HTTP status without reading or rendering server response bodies', async () => {
    fetchMock.mockResolvedValue(new Response('<script>secret</script>', { status: 413 }));
    await expect(
      createAvatarJob('session-123', { provider: 'fal-meshy', prompt: 'Mock input', requestId: 'request-123' }),
    ).rejects.toMatchObject({ name: 'AvatarApiError', status: 413, message: 'Avatar request is too large.' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/jobs/avatar');
  });
});
