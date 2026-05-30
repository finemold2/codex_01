/* map.js — Leaflet 지도 래퍼 (실시간 경로 + 요약 미니맵) */
(function (global) {
  'use strict';

  var TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  var TILE_ATTR = '&copy; OpenStreetMap &copy; CARTO';

  function MapView(elId) {
    this.map = L.map(elId, {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true
    }).setView([37.5665, 126.9780], 16);

    L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19, subdomains: 'abcd' }).addTo(this.map);

    this.line = L.polyline([], { color: '#c6ff00', weight: 6, opacity: 0.9, lineJoin: 'round' }).addTo(this.map);
    this.marker = null;
    this._followed = false;
  }

  MapView.prototype.reset = function () {
    this.line.setLatLngs([]);
    if (this.marker) { this.map.removeLayer(this.marker); this.marker = null; }
    this._followed = false;
  };

  MapView.prototype.addPoint = function (latlng) {
    this.line.addLatLng(latlng);
    if (!this.marker) {
      this.marker = L.circleMarker(latlng, {
        radius: 9, color: '#0b0c10', weight: 3, fillColor: '#c6ff00', fillOpacity: 1
      }).addTo(this.map);
    } else {
      this.marker.setLatLng(latlng);
    }
    // 첫 좌표는 즉시 setView로 위치/줌을 맞추고, 이후에는 부드럽게 따라간다
    if (!this._followed) {
      this.map.setView(latlng, 17);
      this._followed = true;
    } else {
      this.map.panTo(latlng, { animate: true, duration: 0.5 });
    }
  };

  MapView.prototype.invalidate = function () {
    var self = this;
    setTimeout(function () { self.map.invalidateSize(); }, 80);
  };

  /** 정적 경로를 그리고 화면에 맞춤 (요약/상세용) */
  MapView.prototype.showPath = function (path) {
    this.reset();
    if (!path || !path.length) return;
    this.line.setLatLngs(path);
    L.circleMarker(path[0], { radius: 7, color: '#0b0c10', weight: 2, fillColor: '#00e5ff', fillOpacity: 1 }).addTo(this.map);
    L.circleMarker(path[path.length - 1], { radius: 7, color: '#0b0c10', weight: 2, fillColor: '#c6ff00', fillOpacity: 1 }).addTo(this.map);
    var self = this;
    // 모달 slideUp 애니메이션(280ms)이 끝난 뒤 크기/경계를 확정한다
    setTimeout(function () {
      self.map.invalidateSize();
      self.map.fitBounds(self.line.getBounds(), { padding: [24, 24] });
    }, 320);
  };

  global.MapView = MapView;
})(window);
