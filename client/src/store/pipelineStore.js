import { create } from 'zustand';

const initialState = {
  currentPhase: 1,
  phase1: {
    searchResults: null,
    selectedVideo: null,
    orbitId: null,
    orbitStatus: null
  },
  phase2: {
    uploadedFileName: null,
    analysisId: null,
    geminiAnalysis: null,
    geminiAnalysisPath: null,
    geminiReview: null,
    geminiReviewPath: null,
    selectedClaudeTemplate: 'movie_recap'
  },
  phase3: {
    selectedAngle: null,
    claudeScript: null,
    claudeScriptPath: null,
    claudeReview: null,
    claudeReviewPath: null
  },
  phase4: {
    editedSegments: [],
    selectedVoice: null,
    ttsFiles: [],
    captionUnits: [],
    segmentToCaptionMap: {},
    maxCaptionChars: 42,
    srtFile: null,
    batchId: null,
    ttsStatus: 'idle',
    failedSegments: [],
    ttsWarnings: []
  },
  phase5: {
    draftZip: null,
    draftPath: null,
    pendingSourceVideos: [],
    recommendedZip: null,
    zipVariants: null,
    capcutTemplateUsed: false,
    templatePath: null,
    templateLoadStatus: null,
    templateCloneMode: false,
    templateMarkersFound: [],
    missingTemplateMarkers: []
  }
};

export const usePipelineStore = create((set, get) => ({
  ...initialState,
  setCurrentPhase: (phase) => set({ currentPhase: phase }),
  setPhase1: (patch) => set((s) => ({ phase1: { ...s.phase1, ...patch } })),
  setPhase2: (patch) => set((s) => ({ phase2: { ...s.phase2, ...patch } })),
  setPhase3: (patch) => set((s) => ({ phase3: { ...s.phase3, ...patch } })),
  setPhase4: (patch) => set((s) => ({ phase4: { ...s.phase4, ...patch } })),
  setPhase5: (patch) => set((s) => ({ phase5: { ...s.phase5, ...patch } })),
  canAccessPhase: (phase) => {
    const state = get();
    if (phase <= 1) return true;
    if (phase === 2) return !!state.phase1.selectedVideo;
    if (phase === 3) {
      const review = state.phase2.geminiReview;
      return !!state.phase2.geminiAnalysis
        && review?.status === 'approved'
        && review?.checks?.ready_for_claude === true;
    }
    if (phase === 4) {
      const claudeReview = state.phase3.claudeReview;
      return !!state.phase3.claudeScript
        && claudeReview?.status === 'approved'
        && claudeReview?.checks?.ready_for_tts === true;
    }
    if (phase === 5) return true;
    return false;
  }
}));
