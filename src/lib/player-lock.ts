import type Artplayer from 'artplayer';

/**
 * 全平台通用的播放器屏幕锁（防误触）。
 * 不用 ArtPlayer 内置 lock 选项（它只在移动端生效），而是在控制条右侧加锁定按钮，
 * 锁定后：复用 ArtPlayer 的 art-lock 样式藏起底部控制条，全屏透明遮罩层吞掉所有点击，
 * 只留左侧中间的圆形解锁按钮；自研手势与快捷键通过 isLocked 判断同时禁用。
 */
export interface PlayerLockOptions {
  showHint: (text: string) => void;
}

export interface PlayerLockApi {
  isLocked: () => boolean;
  detach: () => void;
}

const ICON_STYLE = 'width:20px;height:20px;display:block';
const LOCK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="${ICON_STYLE}"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
const UNLOCK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="${ICON_STYLE}"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>`;

export function attachPlayerLock(art: Artplayer, options: PlayerLockOptions): PlayerLockApi {
  const { showHint } = options;
  let locked = false;

  const shield = document.createElement('div');
  shield.style.cssText = 'position:absolute;inset:0;display:none;';
  const unlockBtn = document.createElement('div');
  unlockBtn.setAttribute('role', 'button');
  unlockBtn.setAttribute('aria-label', '解锁屏幕');
  unlockBtn.style.cssText = 'position:absolute;left:12px;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;color:#fff;cursor:pointer;';
  unlockBtn.innerHTML = UNLOCK_SVG;
  unlockBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setLocked(false);
  });
  shield.appendChild(unlockBtn);

  const setLocked = (value: boolean) => {
    locked = value;
    art.template.$player.classList.toggle('art-lock', value);
    shield.style.display = value ? 'block' : 'none';
    art.controls.update({
      name: 'screen-lock',
      html: value ? UNLOCK_SVG : LOCK_SVG,
      tooltip: value ? '解锁屏幕' : '锁定屏幕',
    });
    showHint(value ? '屏幕已锁定，点击左侧按钮解锁' : '屏幕已解锁');
  };

  art.controls.add({
    name: 'screen-lock',
    position: 'right',
    html: LOCK_SVG,
    tooltip: '锁定屏幕',
    click: () => setLocked(true),
  });
  art.layers.add({ name: 'screen-lock-shield', html: shield });

  return {
    isLocked: () => locked,
    detach: () => {
      try {
        art.controls.remove('screen-lock');
        art.layers.remove('screen-lock-shield');
        art.template.$player.classList.remove('art-lock');
      } catch {
        // ignore (player already destroyed)
      }
    },
  };
}
