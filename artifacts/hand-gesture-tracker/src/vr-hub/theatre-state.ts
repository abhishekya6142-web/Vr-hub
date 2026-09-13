// Module-scope singleton — React component tree ke BAHAR rehta hai.
// Jab Android file-picker khulta hai to Chrome WebXR session ko
// end() kar deta hai (platform behavior, humara control nahi), jisse
// VRHub poora unmount ho jaata hai aur uske andar ka Theatre state
// (chosen video) normally kho jaata — isse bachane ke liye video ko
// yahan store karte hain, VRHub ke bahar.

type TheatreVideoState = {
  videoUrl: string | null;
  fileName: string;
};

const state: TheatreVideoState = { videoUrl: null, fileName: '' };

export const theatreState = {
  setVideo(url: string, fileName: string) {
    // Purani video revoke karo (memory leak na ho) jab bhi ek naya
    // video select hota hai — genuine replace, yahi sahi jagah hai
    // revoke karne ki (component unmount ke waqt NAHI).
    if (state.videoUrl && state.videoUrl !== url) {
      URL.revokeObjectURL(state.videoUrl);
    }
    state.videoUrl = url;
    state.fileName = fileName;
  },
  getVideo(): TheatreVideoState {
    return { videoUrl: state.videoUrl, fileName: state.fileName };
  },
  hasVideo(): boolean {
    return state.videoUrl !== null;
  },
  clear() {
    if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
    state.videoUrl = null;
    state.fileName = '';
  },
};
