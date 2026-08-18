import PropertiesTab from './PropertiesTab';
import DataTab from './DataTab';
import ERDiagram from './ERDiagram';
import { updateTab } from '../state/store';
import type { TableTab } from '../types';

const SECTIONS: { key: TableTab['activeSection']; label: string }[] = [
  { key: 'properties', label: 'Properties' },
  { key: 'data', label: 'Data' },
  { key: 'er', label: '엔티티 관계도' },
];

export default function TableEditor({ tab }: { tab: TableTab }) {
  return (
    <div className="table-editor">
      <div className="section-tabs" role="tablist">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            role="tab"
            aria-selected={tab.activeSection === s.key}
            className={`section-tab ${tab.activeSection === s.key ? 'active' : ''}`}
            onClick={() => updateTab(tab.id, { activeSection: s.key })}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="section-body">
        {tab.activeSection === 'properties' && <PropertiesTab tab={tab} />}
        {tab.activeSection === 'data' && <DataTab tab={tab} />}
        {tab.activeSection === 'er' && <ERDiagram tab={tab} />}
      </div>
    </div>
  );
}
