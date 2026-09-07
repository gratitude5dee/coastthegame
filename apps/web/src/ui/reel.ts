/**
 * The reel strip (goal.md MIS-4): the track's bars across the top, each mission's range marked, filled gold once it is
 * earned (≥ 1★), with its stars; click an earned mission to watch its best take again. Vanilla DOM, ~1 kB.
 */
import type { Reel } from '@coast/studio';

export interface ReelStrip {
  readonly el: HTMLElement;
  render(reel: Reel, currentMissionId: string | null): void;
  hide(): void;
}

const CSS = `
#coast-reel{position:fixed;top:12px;right:12px;width:min(420px,60vw);z-index:35;pointer-events:none;font:11px system-ui,sans-serif;color:#f2ecdc}
#coast-reel .rl-bars{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:1px;height:10px;border-radius:4px;overflow:hidden;background:rgba(242,236,220,.08)}
#coast-reel .rl-bar{background:rgba(242,236,220,.06)}
#coast-reel .rl-bar.in{background:rgba(255,181,74,.22)}
#coast-reel .rl-bar.earned{background:#ffb54a}
#coast-reel .rl-bar.now{outline:1px solid #f2ecdc;outline-offset:-1px}
#coast-reel .rl-row{display:flex;justify-content:space-between;align-items:center;margin-top:4px;gap:8px}
#coast-reel .rl-label{opacity:.75;letter-spacing:.06em;text-transform:uppercase;font-size:10px}
#coast-reel .rl-missions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
#coast-reel button{pointer-events:auto;font:inherit;color:inherit;background:rgba(11,10,16,.55);border:1px solid rgba(242,236,220,.2);border-radius:6px;padding:3px 7px;cursor:pointer}
#coast-reel button[disabled]{cursor:default;opacity:.55}
#coast-reel button.now{border-color:#ffb54a}
#coast-reel button .st{color:#ffb54a}
@media (max-width:640px){#coast-reel{top:auto;bottom:8px;left:8px;right:auto;width:min(360px,70vw)}}
`;

export function createReelStrip(parent: HTMLElement, onReplay: (missionId: string) => void): ReelStrip {
  const el = document.createElement('div');
  el.id = 'coast-reel';
  el.hidden = true;
  const style = document.createElement('style');
  style.textContent = CSS;
  el.append(style);
  const bars = document.createElement('div');
  bars.className = 'rl-bars';
  bars.setAttribute('role', 'img');
  const row = document.createElement('div');
  row.className = 'rl-row';
  const label = document.createElement('span');
  label.className = 'rl-label';
  const missions = document.createElement('div');
  missions.className = 'rl-missions';
  row.append(label, missions);
  el.append(bars, row);
  parent.appendChild(el);

  return {
    el,
    render(reel, currentMissionId) {
      el.hidden = false;
      const cells: HTMLElement[] = [];
      for (let b = 1; b <= reel.totalBars; b++) {
        const c = document.createElement('i');
        c.className = 'rl-bar';
        cells.push(c);
      }
      for (const e of reel.entries) {
        for (let b = e.bars[0]; b <= e.bars[1]; b++) {
          const c = cells[b - 1];
          if (!c) continue;
          c.classList.add('in');
          if (e.stars >= 1) c.classList.add('earned');
          if (e.missionId === currentMissionId) c.classList.add('now');
        }
      }
      bars.replaceChildren(...cells);
      const p = reel.progress();
      bars.setAttribute('aria-label', `reel: ${p.earnedBars} of ${p.coveredBars} bars earned`);
      label.textContent = `reel ${p.earnedBars}/${p.coveredBars} bars`;
      missions.replaceChildren(
        ...reel.entries.map((e) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.mission = e.missionId;
          b.disabled = !e.takeId;
          if (e.missionId === currentMissionId) b.classList.add('now');
          const stars = '★'.repeat(e.stars) + '☆'.repeat(3 - e.stars);
          b.innerHTML = `${e.title} <span class="st">${stars}</span>`;
          b.title = e.takeId ? `watch the best take of "${e.title}"` : 'no take yet';
          b.addEventListener('click', () => onReplay(e.missionId));
          return b;
        }),
      );
    },
    hide() {
      el.hidden = true;
    },
  };
}
