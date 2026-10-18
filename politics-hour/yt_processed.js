// 업로드 처리 완료 확인(관리자 §7 10-18): 업로드 API 가 영상 ID 를 돌려줘도 처리 단계에서 거절될 수 있다
// (미인증 채널 15분 제한 — ko 10-14 wG-Np9G2kLc·정치JA 10-18). processingStatus 가 succeeded 일 때만 예약·태그 관문·조회 점검을 건다.
// processing 이면 30초마다 최대 waitMin 분 기다린다. 성공이면 true, 실패·거절·시간 초과면 이유 문자열.
module.exports = async function processed(videoId, H, waitMin = 20) {
  for (let t = Date.now(); ; await new Promise((r) => setTimeout(r, 30e3))) {
    const v = (await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=processingDetails,status&id=${videoId}`, { headers: H })).json()).items?.[0];
    if (!v) return '영상 없음';
    const s = v.processingDetails?.processingStatus;
    if (s === 'succeeded') return true;
    if (s && s !== 'processing') return `처리 ${s} (${v.processingDetails.processingFailureReason || v.status.rejectionReason || v.status.uploadStatus})`;
    if (v.status.uploadStatus === 'rejected' || v.status.uploadStatus === 'failed') return `업로드 ${v.status.uploadStatus} (${v.status.rejectionReason || v.status.failureReason || ''})`;
    if (Date.now() - t > waitMin * 60e3) return `${waitMin}분 지나도 처리 중(${s || v.status.uploadStatus})`;
  }
};
