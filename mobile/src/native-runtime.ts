import { PermissionsAndroid, Platform } from 'react-native';
import { mediaDevices, RTCPeerConnection } from 'react-native-webrtc';
import InCallManager from 'react-native-incall-manager';
import { NativeVoiceSession } from './voice-session';

export function createVoiceSession() {
  return new NativeVoiceSession({
    getMedia: async () => {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Microphone permission was denied. Enable it in Settings, then try again.');
      }
      return mediaDevices.getUserMedia({ audio: true, video: false });
    },
    createPeer: () => new RTCPeerConnection({}),
    startAudio: () => { InCallManager.start({ media: 'audio', auto: false }); InCallManager.setKeepScreenOn(true); },
    stopAudio: () => { InCallManager.setKeepScreenOn(false); InCallManager.stop(); },
    setSpeaker: (speaker) => InCallManager.setForceSpeakerphoneOn(speaker),
    fetch: (...args) => fetch(...args),
  });
}
