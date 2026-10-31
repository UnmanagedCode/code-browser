import type { ControllerView } from '../protocol';

interface Props { controller: ControllerView; onTake(): void; onRelease(): void }

export function ControllerBar({ controller, onTake, onRelease }: Props) {
  if (controller.kind === 'human' && controller.you) {
    return (
      <div className="controller-bar" data-holder="you">
        <span>You have control</span>
        <button type="button" onClick={onRelease}>Hand back</button>
      </div>
    );
  }
  return (
    <div className="controller-bar" data-holder={controller.kind === 'agent' ? 'agent' : 'other'}>
      <span>{controller.kind === 'agent' ? 'Agent has control' : 'Another viewer has control'}</span>
      <button type="button" onClick={onTake}>Take control</button>
    </div>
  );
}
