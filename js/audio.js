/* audio.js — 음성 코치 (TTS) + 비프음 + 진동 */
(function (global) {
  'use strict';

  var Coach = {
    enabled: true,
    _ctx: null,
    _koVoice: undefined, // undefined=미탐색, null=없음

    /** 사용자 제스처 시점에 호출 — AudioContext 워밍업 */
    init: function () {
      try {
        if (!this._ctx) {
          var AC = global.AudioContext || global.webkitAudioContext;
          if (AC) this._ctx = new AC();
        }
        if (this._ctx && this._ctx.state === 'suspended') this._ctx.resume();
      } catch (e) { /* 오디오 미지원 */ }
      // 음성 목록은 비동기 로드되므로 미리 건드려 둔다
      if (global.speechSynthesis) global.speechSynthesis.getVoices();
    },

    _voice: function () {
      if (this._koVoice !== undefined) return this._koVoice;
      if (!global.speechSynthesis) { this._koVoice = null; return null; }
      var voices = global.speechSynthesis.getVoices();
      var ko = voices.filter(function (v) { return v.lang && v.lang.indexOf('ko') === 0; });
      this._koVoice = ko[0] || null;
      return this._koVoice;
    },

    /** 한국어 음성 안내 */
    say: function (text) {
      if (!this.enabled || !global.speechSynthesis) return;
      try {
        var u = new SpeechSynthesisUtterance(text);
        u.lang = 'ko-KR';
        u.rate = 1.02;
        u.pitch = 1;
        var v = this._voice();
        if (v) u.voice = v;
        global.speechSynthesis.speak(u);
      } catch (e) { /* 무시 */ }
    },

    stopSpeaking: function () {
      if (global.speechSynthesis) { try { global.speechSynthesis.cancel(); } catch (e) {} }
    },

    /** 짧은 비프 (freq Hz, dur ms) */
    beep: function (freq, dur) {
      if (!this.enabled || !this._ctx) return;
      try {
        var ctx = this._ctx;
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq || 880;
        gain.gain.setValueAtTime(0.25, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (dur || 150) / 1000);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + (dur || 150) / 1000);
      } catch (e) { /* 무시 */ }
    },

    vibrate: function (pattern) {
      if (!this.enabled) return;
      if (navigator.vibrate) { try { navigator.vibrate(pattern || 120); } catch (e) {} }
    },

    /* ---- 시나리오별 안내 ---- */

    countTick: function (n) { this.beep(n === 0 ? 1320 : 880, n === 0 ? 350 : 140); },

    runStart: function () { this.say('러닝을 시작합니다. 화이팅!'); },
    runPause: function () { this.say('일시정지합니다.'); },
    runResume: function () { this.say('러닝을 다시 시작합니다.'); },
    runAutoPause: function () { this.beep(440, 250); this.say('움직임이 없어 자동으로 일시정지했어요.'); },
    runFinish: function () { this.say('러닝 종료. 수고하셨습니다!'); },

    split: function (km, paceStr) {
      this.beep(990, 180);
      this.vibrate(150);
      this.say(km + '킬로미터 통과. 구간 페이스 ' + paceStr + ' 입니다.');
    },

    goalHalf: function () { this.say('목표의 절반을 지났어요. 좋은 페이스예요!'); },
    goalDone: function () {
      this.beep(1320, 400);
      this.vibrate([120, 80, 120, 80, 240]);
      this.say('축하합니다! 목표를 달성했어요.');
    },

    segment: function (seg) {
      this.beep(seg.type === 'run' ? 1180 : 660, 220);
      this.vibrate([100, 60, 100]);
      var min = Math.floor(seg.sec / 60), s = seg.sec % 60;
      var t = (min ? min + '분 ' : '') + (s ? s + '초 ' : '');
      if (seg.label === '워밍업') this.say(t + '동안 가볍게 걸으며 몸을 풀어주세요.');
      else if (seg.label === '쿨다운') this.say('마지막이에요. ' + t + '동안 걸으며 마무리하세요.');
      else if (seg.type === 'run') this.say('달리기 시작! ' + t + '동안 달려보세요.');
      else this.say('잘하셨어요. 이제 ' + t + '동안 걸으며 호흡을 고르세요.');
    },

    sessionDone: function () {
      this.beep(1320, 400);
      this.vibrate([150, 80, 150, 80, 300]);
      this.say('오늘의 트레이닝을 완료했어요. 정말 대단해요!');
    },

    badge: function (name) { this.say('새로운 업적, ' + name + ' 획득!'); }
  };

  global.Coach = Coach;
})(window);
