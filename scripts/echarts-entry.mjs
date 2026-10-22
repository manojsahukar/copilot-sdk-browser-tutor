// Entry for the vendored, tree-shaken ECharts build (public/vendor/echarts.custom.min.js).
// Only what the dashboard widgets need: line/bar/pie, grid/tooltip/legend/title/markLine(thresholds)/dataZoom, canvas renderer.
// No geo/map (its GeoJSON loader is the only `new Function` in ECharts), no SVG/HTML rich tooltips.
// Rebuild: see scripts/build-echarts.sh
import * as echarts from "echarts/core";
import { LineChart, BarChart, PieChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent, TitleComponent, MarkLineComponent, DatasetComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
echarts.use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, TitleComponent, MarkLineComponent, DatasetComponent, CanvasRenderer]);
window.echarts = { init: echarts.init, version: echarts.version };
