import triangleAlert from '../../assets/figma/responder/triangle-alert.svg';
import { LEVEL_LABEL } from '../../ops/derive';
import type { DangerLevel } from '../../ops/types';

/** ⚠ Critical — the icon only for levels that need immediate attention. */
export function DangerLevelTag({ level }: { level: DangerLevel }) {
  const urgent = level === 'critical' || level === 'unreachable';
  return (
    <span className={`level level--${level}`}>
      {urgent && <img src={triangleAlert} width={15} height={15} alt="" />}
      {LEVEL_LABEL[level]}
    </span>
  );
}
