(() => {
  const $ = id => document.getElementById(id);
  const clientId = (() => { let id = localStorage.getItem('skytrack_client_id'); if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : 'st-' + Math.random().toString(36).slice(2)); localStorage.setItem('skytrack_client_id', id); } return id; })();
  const defaults = {view:'globe',layer:'none',opacity:.65,saturation:1.35,center:[34.8,32.1],zoom:4};
  let settings = {...defaults}, config = {}, leafletMap, mapLibre, viewer, weatherLeaflet, weatherCesium, terrainLayer, aircraft = [], flightCache = [], selected = null, refreshTimer = null;
  const headers = {'X-Client-Id':clientId,'Content-Type':'application/json'};
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function api(path, opts={}) { const r = await fetch(path,{...opts,headers:{...headers,...opts.headers}}); const data = await r.json().catch(()=>({})); if(!r.ok) throw new Error(data.detail || `HTTP ${r.status}`); return data; }
  async function init(){
    try { config = await api('/api/config'); } catch(e) { $('sourceNote').textContent='Сервер API недоступен: '+e.message; }
    try { settings = {...defaults,...await api('/api/settings')}; } catch(e) { console.warn('Could not load preferences',e); }
    initLeaflet(); initMapLibre(); initCesium(); bindUI(); applySettings(); updateSourceNote(); await loadFlights();
    refreshTimer = setInterval(loadFlights, 20000);
  }
  function initLeaflet(){
    leafletMap = L.map('map-leaflet',{zoomControl:true,preferCanvas:true,worldCopyJump:true}).setView([settings.center[0],settings.center[1]],settings.zoom);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors © CARTO'}).addTo(leafletMap);
    weatherLeaflet = L.tileLayer('',{opacity:settings.opacity,attribution:'Weather © OpenWeather'});
    terrainLayer = L.tileLayer('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',{opacity:.85,attribution:'Elevation tiles © AWS Terrain Tiles'});
    leafletMap.on('moveend',()=>{const c=leafletMap.getCenter();settings.center=[c.lat,c.lng];settings.zoom=leafletMap.getZoom();debouncedSave();});
  }
  function initMapLibre(){
    try {
      mapLibre = new maplibregl.Map({container:'map',style:{version:8,sources:{osm:{type:'raster',tiles:['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png','https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png','https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],tileSize:256,attribution:'© OpenStreetMap contributors © CARTO'},dem:{type:'raster-dem',tiles:['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],tileSize:256,encoding:'terrarium',maxzoom:15},weather:{type:'raster',tiles:['/api/weather-tile/temperature/{z}/{x}/{y}.png'],tileSize:256,attribution:'Weather © OpenWeather'},elevation:{type:'raster',tiles:['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],tileSize:256,attribution:'Elevation © AWS Terrain Tiles'}},layers:[{id:'base',type:'raster',source:'osm'},{id:'weather-layer',type:'raster',source:'weather',paint:{'raster-opacity':settings.opacity},layout:{visibility:'none'}},{id:'elevation-layer',type:'raster',source:'elevation',paint:{'raster-opacity':0.7},layout:{visibility:'none'}}]},center:[settings.center[1],settings.center[0]],zoom:settings.zoom,pitch:55,bearing:0,antialias:true,attributionControl:true});
      mapLibre.on('load',()=>{try{mapLibre.setTerrain({source:'dem',exaggeration:1.25});mapLibre.addSource('aircraft',{type:'geojson',data:{type:'FeatureCollection',features:[]}});mapLibre.addLayer({id:'aircraft-dots',type:'symbol',source:'aircraft',layout:{'text-field':'✈','text-size':17,'text-rotate':['get','heading'],'text-allow-overlap':true,'text-ignore-placement':true},paint:{'text-color':'#5ff5e5','text-halo-color':'#07111d','text-halo-width':1.5}});mapLibre.on('click','aircraft-dots',e=>{const p=e.features?.[0]?.properties;if(p)showFlight(JSON.parse(p.data));});updateMapLibreFlights();}catch(e){console.warn('MapLibre terrain setup:',e);}});
      mapLibre.on('moveend',()=>{if(settings.view==='map'){const c=mapLibre.getCenter();settings.center=[c.lat,c.lng];settings.zoom=mapLibre.getZoom();debouncedSave();}});
    } catch(e) { console.error('MapLibre failed',e); }
  }
  async function initCesium(){
    try {
      if (config.cesiumIonToken) Cesium.Ion.defaultAccessToken = config.cesiumIonToken;
      // Use a domain-restricted, asset-scoped Cesium ion token; never commit it to source control.
      viewer = new Cesium.Viewer('globe',{animation:false,timeline:false,baseLayerPicker:false,geocoder:false,homeButton:false,sceneModePicker:false,navigationHelpButton:false,infoBox:false,selectionIndicator:false,fullscreenButton:false,shouldAnimate:true,baseLayer:Cesium.ImageryLayer.fromProviderAsync(Cesium.TileMapServiceImageryProvider.fromUrl(Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII')))});
      viewer.scene.globe.enableLighting=true; viewer.scene.globe.depthTestAgainstTerrain=true;
      viewer.camera.setView({destination:Cesium.Cartesian3.fromDegrees(settings.center[1],settings.center[0],settings.view==='globe'?18000000:9000000)});
      if (config.terrainTokenEnabled) { try { viewer.terrainProvider = await Cesium.CesiumTerrainProvider.fromIonAssetId(1); } catch(e){console.warn('Cesium terrain unavailable; using ellipsoid',e);} }
      weatherCesium = new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({url:'/api/weather-tile/{layer}/{z}/{x}/{y}.png'}));
    } catch(e) { console.error('Cesium init failed',e); $('sourceNote').textContent='Глобус не загрузился: проверьте подключение к CDN.'; }
  }
  function bindUI(){
    document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{settings.view=b.dataset.view;applySettings();saveSettings();}));
    document.querySelectorAll('[data-layer]').forEach(b=>b.addEventListener('click',()=>{settings.layer=b.dataset.layer;applySettings();saveSettings();}));
    $('opacity').addEventListener('input',e=>{settings.opacity=Number(e.target.value)/100;applyOpacity();});
    $('opacity').addEventListener('change',saveSettings);
    $('saturation').addEventListener('input',e=>{settings.saturation=Number(e.target.value)/100;applySaturation();});
    $('saturation').addEventListener('change',saveSettings);
    $('showFlights').addEventListener('change',()=>{renderFlights();}); $('refresh').addEventListener('click',loadFlights); $('closeFlight').addEventListener('click',()=>$('flightPanel').classList.add('hidden'));
  }
  function applySettings(){
    document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===settings.view));
    document.querySelectorAll('[data-layer]').forEach(b=>b.classList.toggle('active',b.dataset.layer===settings.layer));
    $('opacity').value=Math.round(settings.opacity*100);$('saturation').value=Math.round(settings.saturation*100);$('opacityValue').textContent=Math.round(settings.opacity*100)+'%';$('saturationValue').textContent=settings.saturation.toFixed(2)+'×';
    $('globe').classList.toggle('active',settings.view==='globe');$('map').classList.toggle('active',settings.view==='map');$('viewLabel').textContent=settings.view==='globe'?'3D GLOBE':'3D TERRAIN MAP';$('layerLabel').textContent=({none:'BASE MAP',temperature:'TEMPERATURE',wind:'WIND',precipitation:'PRECIPITATION',pressure:'PRESSURE',clouds:'CLOUDS',elevation:'ELEVATION'})[settings.layer];
    setTimeout(()=>{leafletMap?.invalidateSize();mapLibre?.resize();viewer?.resize();},100);applyWeather();applyOpacity();applySaturation();renderFlights();
  }
  function applyWeather(){
    const weather=['temperature','wind','precipitation','pressure','clouds'].includes(settings.layer);
    if(weather){const url=`/api/weather-tile/${settings.layer}/{z}/{x}/{y}.png`;weatherLeaflet?.setUrl(url);if(!leafletMap.hasLayer(weatherLeaflet))weatherLeaflet.addTo(leafletMap);weatherLeaflet.setOpacity(settings.opacity);}else if(weatherLeaflet&&leafletMap.hasLayer(weatherLeaflet))leafletMap.removeLayer(weatherLeaflet);
    if(mapLibre?.getLayer('weather-layer')){mapLibre.setLayoutProperty('weather-layer','visibility',weather?'visible':'none');mapLibre.setPaintProperty('weather-layer','raster-opacity',settings.opacity);if(weather){mapLibre.getSource('weather')?.setTiles([`/api/weather-tile/${settings.layer}/{z}/{x}/{y}.png`]);}}
    if(mapLibre?.getLayer('elevation-layer'))mapLibre.setLayoutProperty('elevation-layer','visibility',settings.layer==='elevation'?'visible':'none');
    if(settings.layer==='elevation'){if(!leafletMap.hasLayer(terrainLayer))terrainLayer.addTo(leafletMap);}else if(terrainLayer&&leafletMap.hasLayer(terrainLayer))leafletMap.removeLayer(terrainLayer);
    if(viewer){if(weather && !weatherCesium){weatherCesium=new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({url:`/api/weather-tile/${settings.layer}/{z}/{x}/{y}.png`}));viewer.imageryLayers.add(weatherCesium);}else if(weather&&weatherCesium){viewer.imageryLayers.remove(weatherCesium,false);weatherCesium=new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({url:`/api/weather-tile/${settings.layer}/{z}/{x}/{y}.png`}));viewer.imageryLayers.add(weatherCesium);}else if(weatherCesium){viewer.imageryLayers.remove(weatherCesium,false);weatherCesium=null;}}
  }
  function applyOpacity(){ $('opacityValue').textContent=Math.round(settings.opacity*100)+'%';if(weatherLeaflet)weatherLeaflet.setOpacity(settings.opacity);if(weatherCesium)weatherCesium.alpha=settings.opacity;if(mapLibre?.getLayer('weather-layer'))mapLibre.setPaintProperty('weather-layer','raster-opacity',settings.opacity); }
  function applySaturation(){ $('saturationValue').textContent=settings.saturation.toFixed(2)+'×';const f=`saturate(${settings.saturation})`;if(weatherLeaflet?._container)weatherLeaflet._container.style.filter=f;document.querySelectorAll('.cesium-imageryLayer').forEach(el=>el.style.filter=f);if(mapLibre?.getCanvas())mapLibre.getCanvas().style.filter=f; }
  let saveTimer;function debouncedSave(){clearTimeout(saveTimer);saveTimer=setTimeout(saveSettings,800);}
  async function saveSettings(){try{const r=await api('/api/settings',{method:'PUT',body:JSON.stringify(settings)});$('sourceNote').textContent=r.persisted?'Настройки сохраняются в MongoDB Atlas.':'MongoDB не настроена: настройки сохранены только в этой сессии/браузере.';}catch(e){console.warn('Save settings failed',e);}}
  async function loadFlights(){
    try{
      const bounds=settings.view==='map'&&mapLibre?mapLibre.getBounds():settings.view==='globe'&&viewer?null:leafletMap.getBounds();
      let q='';if(bounds){q=`?lamin=${Math.max(-85,bounds.getSouth())}&lomin=${Math.max(-180,bounds.getWest())}&lamax=${Math.min(85,bounds.getNorth())}&lomax=${Math.min(180,bounds.getEast())}`;if(bounds.getEast()-bounds.getWest()>350)q='';}
      const data=await api('/api/flights'+q);flightCache=data.states||[];$('flightCount').textContent=Number(data.count||0).toLocaleString();$('updated').textContent='Updated '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});renderFlights();
    }catch(e){$('updated').textContent='Flight data unavailable';$('sourceNote').textContent='Источник рейсов временно недоступен: '+e.message;}
  }
  function renderFlights(){
    const list=$('showFlights').checked?flightCache:[];
    if(leafletMap){aircraft.forEach(m=>leafletMap.removeLayer(m));aircraft=[];for(const f of list){const icon=L.divIcon({className:'',html:`<div class="aircraft-marker" style="transform:rotate(${Number(f.heading)||0}deg)">✈</div>`,iconSize:[24,24],iconAnchor:[12,12]});const m=L.marker([f.lat,f.lon],{icon,keyboard:true,title:f.callsign||f.icao24}).on('click',()=>showFlight(f));m.addTo(leafletMap);aircraft.push(m);}}
    updateMapLibreFlights();if(viewer){viewer.entities.removeAll();for(const f of list){viewer.entities.add({position:Cesium.Cartesian3.fromDegrees(f.lon,f.lat,Math.max(100,Number(f.geoAltitude??f.altitude)||100)),label:{text:'✈ '+(f.callsign||f.icao24),font:'12px sans-serif',fillColor:Cesium.Color.fromCssColorString('#5ff5e5'),outlineColor:Cesium.Color.BLACK,outlineWidth:2,style:Cesium.LabelStyle.FILL_AND_OUTLINE,showBackground:true,backgroundColor:Cesium.Color.fromCssColorString('#07111ddd'),pixelOffset:new Cesium.Cartesian2(0,-15),scaleByDistance:new Cesium.NearFarScalar(100000,1,10000000,.3)},point:{pixelSize:4,color:Cesium.Color.CYAN},properties:f});}}
  }
  function updateMapLibreFlights(){if(!mapLibre?.getSource('aircraft'))return;const list=$('showFlights').checked?flightCache:[];mapLibre.getSource('aircraft').setData({type:'FeatureCollection',features:list.map(f=>({type:'Feature',geometry:{type:'Point',coordinates:[f.lon,f.lat]},properties:{heading:Number(f.heading)||0,data:JSON.stringify(f)}}))});}
  function showFlight(f){selected=f;$('flightPanel').classList.remove('hidden');$('flightCallsign').textContent=f.callsign||'Unknown callsign';$('flightIcao').textContent=f.icao24||'—';$('flightCountry').textContent=f.country||'Unknown';$('flightAltitude').textContent=f.altitude==null?'—':Math.round(f.altitude).toLocaleString()+' m';$('flightSpeed').textContent=f.velocity==null?'—':(f.velocity*1.94384).toFixed(0)+' kt';$('flightHeading').textContent=f.heading==null?'—':Math.round(f.heading)+'°';$('flightVertical').textContent=f.verticalRate==null?'—':Number(f.verticalRate).toFixed(1)+' m/s';$('flightPosition').textContent=`${Number(f.lat).toFixed(4)}°, ${Number(f.lon).toFixed(4)}° · ${f.onGround?'On ground':'Airborne'}`;}
  function updateSourceNote(){const bits=[];bits.push(config.mongoEnabled?'MongoDB Atlas connected':'MongoDB not configured');bits.push(config.weatherEnabled?'OpenWeather key detected':'Add OpenWeather API key');bits.push(config.terrainTokenEnabled?'Cesium terrain token detected':'Globe may use ellipsoid without ion terrain');$('sourceNote').textContent=bits.join(' · ');}
  init();
})();
               
