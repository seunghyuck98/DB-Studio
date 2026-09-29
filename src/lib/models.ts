/**
 * Claude 대화에서 고를 수 있는 모델.
 *
 * 모델을 고르지 않으면(`''`) Claude Code 가 쓰는 기본 모델을 그대로 쓴다.
 * `minCli` 가 있는 모델은 그 버전 이상의 Claude Code CLI 에서만 쓸 수 있다 —
 * 낮은 버전에서 고르면 API 가 400 을 돌려주므로, 목록에서 미리 막고 이유를 알려 준다.
 *
 * 목록과 최소 버전은 실제로 모델을 하나씩 호출해 확인한 값이다 (2026-09 기준).
 * CLI 를 올리면(`claude update`) 막혀 있던 모델이 풀리고, 기본값이 가리키는 모델도 최신으로 바뀐다.
 */
export interface ChatModel {
  id: string;
  label: string;
  hint: string;
  /** 이 모델을 쓰려면 필요한 최소 Claude Code 버전 */
  minCli?: string;
}

export const CHAT_MODELS: ChatModel[] = [
  { id: '', label: '기본값', hint: 'Claude Code 가 고르는 모델 (CLI 버전에 따라 달라진다)' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: '가장 똑똑한 최신 모델. 복잡한 쿼리·실행 계획 분석에 좋지만 느리고 토큰을 많이 쓴다', minCli: '2.1.280' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: '최신 Sonnet. 속도와 성능의 균형 — 평소 조회·쿼리 작성에 알맞다' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', hint: '최신 Fable', minCli: '2.1.251' },
  { id: 'claude-opus-5', label: 'Opus 5', hint: '이전 세대 Opus' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', hint: '이전 세대 Sonnet' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', hint: '가장 빠르고 토큰을 적게 쓴다. 간단한 조회·구조 확인에' },
];

/** "2.1.121" 같은 버전 비교. a < b 면 음수. */
export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 이 모델을 지금 쓸 수 있는지. CLI 버전을 모르면(null) 막지 않는다 —
 * 확인 못 했다고 고를 수 있는 모델을 숨기는 쪽이 더 나쁘다.
 */
export function modelAvailable(model: ChatModel, cliVersion: string | null): boolean {
  if (!model.minCli || !cliVersion) return true;
  return compareVersion(cliVersion, model.minCli) >= 0;
}

export function modelLabel(id: string): string {
  return CHAT_MODELS.find((m) => m.id === id)?.label ?? id;
}
