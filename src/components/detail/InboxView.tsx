import { Section } from './shared';

export function InboxView({
  agentIds,
  onAssign,
}: {
  agentIds: string[];
  onAssign: (id: string) => void;
}) {
  return (
    <>
      <div className="text-sm text-neutral-400">This task is unassigned.</div>
      <Section title="Assign to agent">
        <div className="flex flex-wrap gap-2">
          {agentIds.map((id) => (
            <button
              key={id}
              onClick={() => onAssign(id)}
              className="px-3 py-1.5 text-xs bg-neutral-800 hover:bg-neutral-700 rounded border border-neutral-700 hover:border-neutral-600"
            >
              {id}
            </button>
          ))}
        </div>
      </Section>
    </>
  );
}
