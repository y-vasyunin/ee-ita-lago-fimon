// #############################################################################
// ### EXTERNAL PACKAGES ###
// #############################################################################

var txt = require("users/jarickkk/packages:gena-text-dih");
var plt = require("users/jarickkk/packages:gena-palettes");
var dat = require("users/jarickkk/packages:datasets");
var bsm = require("users/jarickkk/packages:basemaps");
var prc = require("users/jarickkk/packages:processing");

// #############################################################################
// ### INPUT PARAMETERS ###
// #############################################################################

// Area of interest
var lakes = ee.FeatureCollection("users/jarickkk/geoportale-veneto/laghi");
var lakeField = "nome";
var lakeName = "LAGO DI FIMON";
var bufDist = 500;  // bounding box around aoi, in meters

// Time period (YYYY-MM-dd)
var startDateStr = "2017-05-01";  // s2.dateStart
var endDateStr = "2021-08-30";  // func.currentDateTime().date

// Imagery and indices
var s2 = dat.imgCollections.sent2;
var maxClouds = 40;  // percentage
var minNDVI = 0.4;  // threshold to separate vegetation

// Map visualization
var mapStyle = "silver";  // ROADMAP, SATELLITE, HYBRID, TERRAIN
                          // retro, silver, dark, night, aubergine
var visNDVI = {min: 0.0, max: 0.5, palette: plt.cmocean.Algae[7]};
var visNDVI2 = {
  bands: "NDVI_median",
  min: -0.5, max: 0.9,
  palette: plt.cmocean.Speed[7]
};
// palettes: https://github.com/gee-community/ee-palettes#user-content-palettes
var rgbBands = ["RED_median", "GREEN_median", "BLUE_median"];
var visRGB = {bands: rgbBands, min: 192, max: 1106};
var nirBands = ["NIR_median", "RED_median", "GREEN_median"];
var visNIR = {bands: nirBands, min: 60, max: 4000};
var BWBand = ["GREEN"];
var visBW = {bands: BWBand, min: 192, max: 1106, forceRgbOutput: true};

// Map labels
var label = "" + lakeName + " ";
var annot = [
  {
    position: "top",
    offset: "5%",
    margin: "2%",
    property: "date",
    scale:  11,  // empiric value - it's bigger for smaller scales
    fontType: "Consolas", fontSize: 18,  // Consolas 18 or Arial 64
    textOpacity: 1.0,
    texWidth: 2.0,
    outlineWidth: 2.0,
    outlineOpacity: 1.0,
  },
];

// Export
var crsMap = "EPSG:3857";  // for map output
var crsCalc = "EPSG:32632";  // for area calculation
var scaleS2 = s2.scale;  // ground sample distance in meters (for 'scale')
var maxPxCount = 1e13;  // max pixel count for export image, exponential form
var fps = 2;  // frames per second
var maxDim = 500;  //max dimensions of the thumbnail to render, in pixels
//var baseFolderName = "EarthEngine";
//var attributeList = ["field1", "field2", "field3"];
//var projectID = prc.camelize(lakeName);

// #############################################################################
// ### IMPLEMENTATION ###
// #############################################################################

print("Time period:", startDateStr, endDateStr);

// define area of interest
var aoi = lakes.filter(ee.Filter.eq(lakeField, lakeName));
var bboxPrecise = aoi.geometry().bounds();
var bboxWide = bboxPrecise.buffer(bufDist).bounds();  // a bit bigger extent

// prepare image collection
var s2imColF = ee.ImageCollection(s2.path)
  .map(prc.s2mask)
  .map(prc.renameBands(s2.bandIds, s2.bandNames))
  .filter(ee.Filter.lt(s2.cloudAttribute, maxClouds));

var s2imCol = s2imColF  // used to know the size of the initial collection
  .filterDate(startDateStr, endDateStr)
  .filterBounds(bboxWide);
print("S2 collection size:", s2imCol.size());

// add spectral index as a new band
s2imColF = s2imColF.map(prc.addNDVI);

// image collection of monthly median composites
var interval = 1;
var increment = "month";
// make a list of start months
var startDate = ee.Date(startDateStr);
var secondDate = startDate.advance(interval, increment).millis();
var increase = secondDate.subtract(startDate.millis());
var dateList = ee.List.sequence(
  startDate.millis(),
  ee.Date(endDateStr).millis(),
  increase
);
var s2millis = ee.ImageCollection.fromImages(
  dateList.map(
    function (date) {
      return s2imColF.filterDate(
        ee.Date(date),
        ee.Date(date).advance(interval, increment))
        .median()
        .set("system:time_start", ee.Date(date).millis()
        );
    })
);
// create NDVI median composite image
var s2doy = s2millis;
var s2doy = s2doy.map(function (img) {
  var doy = ee.Date(img.get("system:time_start")).getRelative("day", "year");
  img = img.set({"doy": doy, "date": img.date().format("Y M")});
  return img;
});
var s2doyDistinct = s2doy.filterDate(startDateStr, endDateStr);

// define a filter that identifies, which images from the complete collection
// match the DOY from the distinct DOY collection
var doyFilter = ee.Filter.equals({leftField: "doy", rightField: "doy"});
// define a join
var join = ee.Join.saveAll("doy_matches");
// apply the join and convert the resulting FeatureCollection
// to an ImageCollection
var joinCol = ee.ImageCollection(join.apply(s2doyDistinct, s2doy, doyFilter));
// apply median reduction among matching DOY collections
var s2NDVIdate = joinCol.map(function (img) {
  var doyCol = ee.ImageCollection.fromImages(img.get("doy_matches"));
  return doyCol.reduce(ee.Reducer.median()).set({"date": img.get("date")});
});
print("Size of the monthly composite collection:", s2NDVIdate.size());

// calculate pixel area in hectares
function makeBinary(img) {
  var binaryNDVI = img.select("NDVI_median")
    .gt(minNDVI)
    .rename("NDVI_binary")
    .clip(aoi);
  binaryNDVI = binaryNDVI.set("date", img.get("date"));
  return binaryNDVI;
}
var pxArea = ee.Image.pixelArea().reproject({crs: crsCalc, scale: scaleS2});
function areaMultiply(img) {
  var imgBand = img.select("NDVI_binary")
    .multiply(pxArea).divide(10000)  // convert from meters to hectares
    .rename("NDVI_ha");
  return imgBand.copyProperties(img, ['date']);
}

function printInfo(imgColl) {
  print("S2 Result:", imgColl);
  
} 

var NDVIbinaryArea = s2NDVIdate.map(makeBinary).aside(print).map(areaMultiply).aside(print);
// print("S2 Result:", NDVIbinaryArea.getInfo());
// print("S2 Result:", NDVIbinaryArea.evaluate(fu));
NDVIbinaryArea.evaluate(printInfo);

// #############################################################################
// ### VISUALIZATION ###
// #############################################################################

// ### MAP CANVAS ###
Map.centerObject(aoi, 14);

// add a basemap from the configured value
if (bsm.customList.indexOf(mapStyle) >= 0) {
  Map.setOptions("Custom", {Custom: bsm[mapStyle]});
} else if (bsm.googleList.indexOf(mapStyle) >= 0) {
  Map.setOptions(mapStyle);
} else {
  print("WARNING: Specified basemap not found. Use default map style instead.");
}

var imgVisNDVI = s2imColF.select("NDVI").median().clip(aoi).visualize(visNDVI);
var imgVisBW = s2imColF.select(BWBand).median().clip(bboxWide).visualize(visBW);

// Map layers
//Map.addLayer(compMask, {palette: "blue, green"}, "compMask");
Map.addLayer(s2NDVIdate, visNIR, "NIR (Last)", false);
Map.addLayer(s2NDVIdate, visRGB, "RGB (Last)", true);
Map.addLayer(s2NDVIdate, visNDVI2, "NDVI (Last)", true);
Map.addLayer(NDVIbinaryArea, {}, "Binary NDVI with hectares (Last)", false);
Map.addLayer(imgVisBW, {}, "B/W Vis (Median)", false);
Map.addLayer(imgVisNDVI.clip(aoi), {}, "NDVI Vis (Median)", false);

// ### CHART ###
var chart =
  ui.Chart.image
    .series({
      imageCollection: NDVIbinaryArea,
      region: aoi,
      reducer: ee.Reducer.sum(),
      scale: scaleS2,
      xProperty: "date"
    })
    .setOptions({
      title: "Dinamica mensile dell'estensione di vegetazione lacustre/palustre",
      chartArea: {backgroundColor: "EBEBEB"},
      legend: {position: "none"},
      hAxis: {
        title: "Data",
        titleTextStyle: {italic: false, bold: true},
        gridlines: {color: "white"}
      },
      vAxis: {
        title: "Area totale di vegetazione, ha",
        titleTextStyle: {italic: false, bold: true},
        gridlines: {color: "white"},
        baselineColor: "white"
      },
      lineWidth: 3,
      colors: ["green"],
      //curveType: "function"
    });
print(chart);

// ### ANIMATED TIME SERIES ###

// RGB visualization images to be used as animation frames
function makeMosaic(img) {
  var imgBack = img.select(BWBand)
    .clip(bboxWide)
    .visualize(visBW);
  var imgFront = img.select("NDVI")
    .clip(aoi)
    .visualize(visNDVI)
    .set({date: img.get("date")});
  var mosaic = ee.ImageCollection([imgBack, imgFront]).mosaic()
    .unmask(0)
    .set({date: img.get("date")});
  return txt.annotateImage(mosaic, {}, bboxWide, annot, label);
}
var rgbVis = s2doy.map(makeMosaic);

// define GIF visualization parameters
var gifParams = {
  region: bboxWide,
  dimensions: maxDim,
  framesPerSecond: fps,
  crs: crsMap,
  maxPixels: maxPxCount,
};

// print the GIF URL to the console
print("GENERATED GIF ANIMATION:", rgbVis.getVideoThumbURL(gifParams));
