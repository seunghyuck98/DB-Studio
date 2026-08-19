import { useEffect } from 'react';

export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** 위에 구분선을 그린다 */
  separated?: boolean;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** 화면 아무 곳이나 누르거나 Esc 를 치면 닫히는 우클릭 메뉴. */
export default function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 화면 오른쪽·아래로 넘치지 않게 위치를 살짝 당긴다.
  const left = Math.min(menu.x, window.innerWidth - 200);
  const top = Math.min(menu.y, window.innerHeight - (menu.items.length * 28 + 16));

  return (
    <ul className="context-menu" style={{ left: Math.max(4, left), top: Math.max(4, top) }}>
      {menu.items.map((item, i) => (
        <li key={i} className={item.separated ? 'separated' : ''}>
          <button
            className={item.danger ? 'danger' : ''}
            disabled={item.disabled}
            onClick={() => { onClose(); item.action(); }}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  );
}
