// ── Mapbox Setup ─────────────────────────────────────────────
mapboxgl.accessToken = 'pk.eyJ1IjoidGhvbWFzZGN1bmciLCJhIjoiY213ZXg4MjZlMDA2dDMxcTB5bTU3ZHBoMiJ9.5kq3bkD3CGQIDsPoZUPiHA';

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/streets-v12',
    center: [-71.0589, 42.3601],   // Boston
    zoom: 12,
    minZoom: 10,
    maxZoom: 18
});

map.addControl(new mapboxgl.NavigationControl(), 'top-left');

// ── SVG Overlay ──────────────────────────────────────────────
const svg = d3.select(map.getCanvasContainer()).append('svg');

// Tooltip element
const tooltip = d3.select('body')
    .append('div')
    .attr('class', 'station-tooltip')
    .style('display', 'none');

// ── Scales ───────────────────────────────────────────────────
const radiusScale = d3.scaleSqrt().range([0, 25]);
const colorScale = d3.scaleQuantize()
    .domain([-1, 1])
    .range([
        '#4575b4', // heavy arrivals (blue)
        '#91bfdb',
        '#e0f3f8',
        '#fee090',
        '#fc8d59',
        '#d73027'  // heavy departures (orange-red)
    ]);

// ── Data URLs ────────────────────────────────────────────────
const STATIONS_URL = 'https://vis-society.github.io/labs/9/data/bluebikes-stations.csv';
const TRAFFIC_URL  = 'https://vis-society.github.io/labs/9/data/bluebikes-traffic-2024-03.csv';
const BOSTON_LANES  = 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson?outSR=%7B%22latestWkid%22%3A3857%2C%22wkid%22%3A102100%7D';

// ── Helpers ──────────────────────────────────────────────────
function getCoords(station) {
    const point = new mapboxgl.LngLat(+station.Long, +station.Lat);
    const { x, y } = map.project(point);
    return { cx: x, cy: y };
}

function formatTime(minutes) {
    if (minutes < 0) return 'Any time';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const period = h < 12 ? 'AM' : 'PM';
    const displayH = h % 12 === 0 ? 12 : h % 12;
    return `${displayH}:${String(m).padStart(2, '0')} ${period}`;
}

function minutesSinceMidnight(date) {
    return date.getHours() * 60 + date.getMinutes();
}

/**
 * Compute departures, arrivals, totalTraffic, and flow ratio
 * for each station given a (possibly filtered) set of trips.
 */
function computeStationTraffic(stations, trips) {
    const departures = d3.rollup(trips, v => v.length, d => d.start_station_id);
    const arrivals   = d3.rollup(trips, v => v.length, d => d.end_station_id);

    for (const s of stations) {
        s.departures    = departures.get(s.Number) ?? 0;
        s.arrivals      = arrivals.get(s.Number)   ?? 0;
        s.totalTraffic  = s.departures + s.arrivals;
        // flow: +1 = all departures, -1 = all arrivals, 0 = balanced
        s.flow = s.totalTraffic === 0
            ? 0
            : (s.departures - s.arrivals) / s.totalTraffic;
    }
}

// ── Main ─────────────────────────────────────────────────────
map.on('load', async () => {

    // ── Step 2: Bike lanes ───────────────────────────────────
    map.addSource('boston_route', { type: 'geojson', data: BOSTON_LANES });
    map.addLayer({
        id: 'boston_lanes',
        type: 'line',
        source: 'boston_route',
        paint: {
            'line-color': '#32D400',
            'line-width': 3,
            'line-opacity': 0.4
        }
    });

    // ── Step 3 & 4: Load data ────────────────────────────────
    const [stations, trips] = await Promise.all([
        d3.csv(STATIONS_URL),
        d3.csv(TRAFFIC_URL)
    ]);

    // Parse dates for time filtering (Step 5)
    for (const t of trips) {
        t.started_at = new Date(t.started_at);
        t.ended_at   = new Date(t.ended_at);
    }

    // Initial traffic computation (all trips)
    computeStationTraffic(stations, trips);

    // Set radius scale domain based on full data
    radiusScale.domain([0, d3.max(stations, d => d.totalTraffic)]);

    // ── Draw station circles ─────────────────────────────────
    const circles = svg.selectAll('circle')
        .data(stations)
        .join('circle')
        .attr('r', d => radiusScale(d.totalTraffic))
        .attr('fill', d => colorScale(d.flow))
        .on('mouseover', (event, d) => {
            tooltip
                .style('display', 'block')
                .style('left', event.pageX + 'px')
                .style('top', event.pageY + 'px')
                .html(`
                    <strong>${d.NAME}</strong><br>
                    Departures: ${d.departures}<br>
                    Arrivals: ${d.arrivals}<br>
                    Total: ${d.totalTraffic}
                `);
        })
        .on('mouseout', () => tooltip.style('display', 'none'));

    // Position circles via projection
    function updatePositions() {
        circles
            .attr('cx', d => getCoords(d).cx)
            .attr('cy', d => getCoords(d).cy);
    }

    updatePositions();

    map.on('move',    updatePositions);
    map.on('zoom',    updatePositions);
    map.on('resize',  updatePositions);
    map.on('moveend', updatePositions);

    // ── Step 5: Time slider ──────────────────────────────────
    const slider    = document.getElementById('time-slider');
    const timeLabel = document.getElementById('selected-time');

    slider.addEventListener('input', () => {
        const value = +slider.value;
        timeLabel.textContent = formatTime(value);

        let filtered;
        if (value < 0) {
            // Show all trips
            filtered = trips;
        } else {
            // Filter: trips that departed within ± 60 min of selected time
            filtered = trips.filter(t => {
                const m = minutesSinceMidnight(t.started_at);
                const diff = Math.abs(m - value);
                return Math.min(diff, 1440 - diff) <= 60;
            });
        }

        computeStationTraffic(stations, filtered);
        radiusScale.domain([0, d3.max(stations, d => d.totalTraffic) || 1]);

        circles
            .attr('r', d => radiusScale(d.totalTraffic))
            .attr('fill', d => colorScale(d.flow));
    });

    // ── Step 6: Legend ───────────────────────────────────────
    const legendDiv = document.createElement('div');
    legendDiv.id = 'legend';
    legendDiv.innerHTML = `
        <h4>Traffic Flow</h4>
        <div class="legend-row">
            <span class="legend-swatch" style="background:${colorScale(-1)}"></span>
            More arrivals
        </div>
        <div class="legend-row">
            <span class="legend-swatch" style="background:${colorScale(0)}"></span>
            Balanced
        </div>
        <div class="legend-row">
            <span class="legend-swatch" style="background:${colorScale(1)}"></span>
            More departures
        </div>
        <h4 style="margin-top:8px">Circle Size</h4>
        <div>= total trips (area-proportional)</div>
    `;
    document.getElementById('map').appendChild(legendDiv);
});
