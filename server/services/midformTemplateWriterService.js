function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function bulletList(items, fallback = 'available evidence only') {
  const list = (Array.isArray(items) ? items : []).map(normalizeText).filter(Boolean);
  return list.length ? list.map((item) => `- ${item}`).join('\n') : `- ${fallback}`;
}

function keywordList(summary) {
  const keywords = Array.isArray(summary?.repeated_keywords) ? summary.repeated_keywords : [];
  return keywords.map((item) => typeof item === 'string' ? item : `${item.keyword || ''}${item.count ? ` (${item.count})` : ''}`).filter(Boolean);
}

function buildTemplateBody(locale, evidencePack = {}) {
  const isJa = locale === 'ja';
  const reaction = evidencePack.comment_reaction_summary || {};
  const retention = evidencePack.retention_signals || {};
  const heatmap = evidencePack.heatmap_signals || {};
  const dialogue = (evidencePack.must_keep_dialogue_candidates || [])
    .flatMap((item) => Array.isArray(item.dialogue_lines) ? item.dialogue_lines : [])
    .slice(0, 8);
  const visuals = (evidencePack.must_keep_visual_candidates || evidencePack.scene_candidates || [])
    .map((item) => item.scene_summary || item.summary || item.role || item.beat_id || item.slot_id)
    .slice(0, 10);
  const sceneMentions = Array.isArray(reaction.scene_mentions) ? reaction.scene_mentions.slice(0, 8) : [];
  const misunderstandings = Array.isArray(reaction.misunderstandings) ? reaction.misunderstandings.slice(0, 8) : [];
  const topMoments = Array.isArray(retention.top_moments) ? retention.top_moments.slice(0, 6).map((item) => JSON.stringify(item)) : [];
  const replayWindows = Array.isArray(heatmap.high_replay_windows) ? heatmap.high_replay_windows.slice(0, 6).map((item) => JSON.stringify(item)) : [];
  const heatmapSource = normalizeText(heatmap.source || 'youtube_public_most_replayed');
  const verifiedCharacters = Array.isArray(evidencePack.verified_facts?.characters) ? evidencePack.verified_facts.characters : [];
  const verifiedEvents = Array.isArray(evidencePack.verified_facts?.events) ? evidencePack.verified_facts.events : [];
  return [
    `# ${isJa ? 'JA' : 'KO'} Auto Template Body`,
    '',
    '## Recap intent',
    isJa
      ? '視聴者の反応と保持シグナルを根拠に、緊張を先に積み上げてから真相を回収する。字幕差し替えではなく、反応ショットと間を使う別編集にする。'
      : '댓글 반응과 retention/heatmap 신호를 근거로, 초반 갈등을 빠르게 제시하고 후반 callback payoff로 회수한다. 자막만 바꾸지 말고 실제 컷 체인을 다르게 구성한다.',
    '',
    '## Viewer question',
    isJa ? 'この場面で何が本当に起きていて、なぜその一言が流れを変えるのか?' : '이 장면에서 진짜로 무슨 일이 벌어졌고, 왜 그 한마디가 판을 바꾸는가?',
    '',
    '## Callback payoff',
    isJa ? '序盤の疑問을 中盤以降の表情・反応・대사 근거로 회수한다.' : '초반 질문을 중후반의 표정, 반응, 대사 근거로 반드시 회수한다.',
    '',
    '## Verified characters',
    bulletList(verifiedCharacters, 'derive character references only from verified source metadata, transcript, and movie research'),
    '',
    '## Verified events',
    bulletList(verifiedEvents, 'derive event claims only from verified scene candidates and transcript evidence'),
    '',
    '## Must keep dialogue',
    bulletList(dialogue, 'no verified dialogue candidate; use transcript-grounded dialogue only'),
    '',
    '## Must keep visual events',
    bulletList(visuals, 'use verified scene candidates from the evidence pack'),
    '',
    '## Comment reaction influence',
    bulletList([...keywordList(reaction), ...sceneMentions], 'comments unavailable or empty; do not invent viewer reactions'),
    '',
    '## Misunderstandings to avoid',
    bulletList(misunderstandings, 'avoid unsupported identities, motivations, and off-screen plot claims'),
    '',
    '## Retention / heatmap influence',
    bulletList([...topMoments, ...replayWindows], 'retention/heatmap unavailable; prioritize transcript, scene candidates, and dialogue evidence'),
    `- Heatmap source: ${heatmapSource}`,
    isJa
      ? '- Use public Most Replayed windows as tension/payoff anchors, but reveal them after a measured buildup instead of copying the KO opening.'
      : '- Use public Most Replayed windows for the opening hook, must-keep visual callbacks, and fastest payoff setup when they overlap verified scene candidates.',
    '',
    '## Prohibitions',
    '- Do not invent facts not present in evidence_pack.json.',
    '- Do not use English fallback narration for KO/JA output.',
    '- Do not make JA a caption-only duplicate of KO; edit plan and final video track must diverge.',
    '- Do not use random offset retry; only deterministic source clip chain replanning is allowed.',
    ''
  ].join('\n');
}

module.exports = {
  buildTemplateBody
};
