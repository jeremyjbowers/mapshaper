/* @requires shp-reader, dbf-reader, mapshaper-common, mapshaper-geom */

MapShaper.importDbf = function(src) {
  T.start();
  var data = new DbfReader(src).read("table");
  T.stop("[importDbf()]");
  return data;
};

// Reads Shapefile data from an ArrayBuffer or Buffer
// Converts to format used for identifying topology.
//

MapShaper.importShp = function(src) {
  T.start();
  var reader = new ShpReader(src);

  var supportedTypes = [
    ShpType.POLYGON, ShpType.POLYGONM, ShpType.POLYGONZ,
    ShpType.POLYLINE, ShpType.POLYLINEM, ShpType.POLYLINEZ
  ];
  if (!Utils.contains(supportedTypes, reader.type())) {
    stop("Only polygon and polyline Shapefiles are supported.");
  }
  if (reader.hasZ()) {
    trace("Warning: Z data is being removed.");
  } else if (reader.hasM()) {
    trace("Warning: M data is being removed.");
  }

  var counts = reader.getCounts(),
      xx = new Float64Array(counts.pointCount),
      yy = new Float64Array(counts.pointCount),
      shapeIds = [];

  var expectRings = Utils.contains([5,15,25], reader.type()),
      findMaxParts = expectRings,
      findHoles = expectRings,
      pathData = [];

  var pointId = 0,
      partId = 0,
      shapeId = 0;


  // TODO: test cases: null shape; non-null shape with no valid parts

  reader.forEachShape(function(shp) {
    var maxPartId = -1,
        maxPartArea = 0,
        signedPartArea, partArea, startId;

    var partsInShape = shp.partCount,
        pointsInShape = shp.pointCount,
        partSizes = shp.readPartSizes(),
        coords = shp.readCoords(),
        pointsInPart, validPointsInPart,
        pathObj,
        err,
        x, y, prevX, prevY;

    if (partsInShape != partSizes.length) error("Shape part mismatch");

    for (var j=0, offs=0; j<partsInShape; j++) {
      pointsInPart = partSizes[j];
      startId = pointId;
      for (var i=0; i<pointsInPart; i++) {
        x = coords[offs++];
        y = coords[offs++];
        if (i == 0 || prevX != x || prevY != y) {
          xx[pointId] = x;
          yy[pointId] = y;
          pointId++;
        } else {
          // trace("Duplicate point:", x, y)
        }
        prevX = x, prevY = y;
      }

      validPointsInPart = pointId - startId;

      pathObj = {
        size: validPointsInPart,
        isHole: false,
        isPrimary: false,
        isNull: false,
        // isRing: expectRings,
        shapeId: shapeId
      }

      if (expectRings) {
        signedPartArea = msSignedRingArea(xx, yy, startId, pointsInPart);
        err = null;
        if (validPointsInPart < 4) {
          err = "Only " + validPointsInPart + " valid points in ring";
        } else if (signedPartArea == 0) {
          err = "Zero-area ring";
        } else if (xx[startId] != xx[pointId-1] || yy[startId] != yy[pointId-1]) {
          err = "Open path";
        }

        if (err != null) {
          trace("Invalid ring in shape:", shapeId, "--", err);
          // pathObj.isNull = true;
          pointId -= validPointsInPart; // backtrack...
          continue;
        }

        if (findMaxParts) {
          partArea = Math.abs(signedPartArea);
          if (partArea > maxPartArea) {
            maxPartId = partId;
            maxPartArea = partArea;
          }
        }

        if (findHoles) {
          if (signedPartArea < 0) {
            if (partsInShape == 1) error("Shape", shapeId, "only contains a hole");
            pathObj.isHole = true;
          }
        }
      } else { // no rings (i.e. polylines)
        if (validPointsInPart < 2) {
          trace("Collapsed path in shape:", shapeId, "-- skipping");
          pointId -= validPointsInPart;
          continue;
        }
      }

      shapeIds.push(shapeId);
      pathData.push(pathObj);
      partId++;
    }  // forEachPart()

    if (maxPartId > -1) {
      pathObj.isPrimary = true;
    }
    shapeId++;
  });  // forEachShape()

  var skippedPoints = counts.pointCount - pointId,
      skippedParts = counts.partCount - partId;
  if (counts.shapeCount != shapeId || skippedPoints < 0 || skippedParts < 0)
    error("Counting problem");

  if (skippedPoints > 0) {
    // trace("* Skipping", skippedPoints, "invalid points");
    xx = xx.subarray(0, pointId);
    yy = yy.subarray(0, pointId);
  }

  var info = {
    input_bounds: reader.header().bounds,
    input_point_count: pointId,
    input_part_count: partId,
    input_shape_count: shapeId,
    input_skipped_points: skippedPoints,
    input_skipped_parts: skippedParts,
    input_geometry_type: expectRings ? "polygon" : "polyline"
  };
  T.stop("Import Shapefile");
  return {
    xx: xx,
    yy: yy,
    pathData: pathData,
    info: info
  };
};

// Convert topological data to buffers containing .shp and .shx file data
//
MapShaper.exportShp = function(arcs, shapes, shpType) {
  if (!Utils.isArray(arcs) || !Utils.isArray(shapes)) error("Missing exportable data.");
  T.start();
  T.start();

  var fileBytes = 100;
  var bounds = new Bounds();
  var shapeBuffers = Utils.map(shapes, function(shape, i) {
    var shpObj = MapShaper.exportShpRecord(shape, arcs, i+1, shpType);
    fileBytes += shpObj.buffer.byteLength;
    shpObj.bounds && bounds.mergeBounds(shpObj.bounds);
    return shpObj.buffer;
  });

  T.stop("export shape records");
  T.start();

  // write .shp header section
  var shpBin = new BinArray(fileBytes, false)
    .writeInt32(9994)
    .skipBytes(5 * 4)
    .writeInt32(fileBytes / 2)
    .littleEndian()
    .writeInt32(1000)
    .writeInt32(shpType)
    .writeFloat64(bounds.xmin)
    .writeFloat64(bounds.ymin)
    .writeFloat64(bounds.xmax)
    .writeFloat64(bounds.ymax)
    .skipBytes(4 * 8); // skip Z & M type bounding boxes;

  // write .shx header
  var shxBytes = 100 + shapeBuffers.length * 8;
  var shxBin = new BinArray(shxBytes, false)
    .writeBuffer(shpBin.buffer(), 100) // copy .shp header to .shx
    .position(24)
    .bigEndian()
    .writeInt32(shxBytes/2)
    .position(100);

  // write record sections of .shp and .shx
  Utils.forEach(shapeBuffers, function(buf, i) {
    var shpOff = shpBin.position() / 2,
        shpSize = (buf.byteLength - 8) / 2; // alternative: shxBin.writeBuffer(buf, 4, 4);
    shxBin.writeInt32(shpOff)
    shxBin.writeInt32(shpSize);
    shpBin.writeBuffer(buf);
  });

  var shxBuf = shxBin.buffer(),
      shpBuf = shpBin.buffer();

  T.stop("convert to binary");
  T.stop("Export Shapefile");
  return {shp: shpBuf, shx: shxBuf};
};


// Returns an ArrayBuffer containing a Shapefile record for one shape
//   and the bounding box of the shape.
// TODO: remove collapsed rings, convert to null shape if necessary
//
MapShaper.exportShpRecord = function(shape, arcs, id, shpType) {
  var bounds = null,
      bin = null;
  if (shape && shape.length > 0) {
    var data = MapShaper.convertTopoShape(shape, arcs, ShpType.polygonType(shpType)),
        partsIdx = 52,
        pointsIdx = partsIdx + 4 * data.partCount,
        recordBytes = pointsIdx + 16 * data.pointCount,
        pointCount = 0;

    data.pointCount == 0 && trace("Empty shape; data:", data)
    if (data.pointCount > 0) {
      bounds = data.bounds;
      bin = new BinArray(recordBytes, false)
        .writeInt32(id)
        .writeInt32((recordBytes - 8) / 2)
        .littleEndian()
        .writeInt32(shpType)
        .writeFloat64(bounds.xmin)
        .writeFloat64(bounds.ymin)
        .writeFloat64(bounds.xmax)
        .writeFloat64(bounds.ymax)
        .writeInt32(data.partCount)
        .writeInt32(data.pointCount);

      Utils.forEach(data.parts, function(part, i) {
        bin.position(partsIdx + i * 4)
          .writeInt32(pointCount)
          .position(pointsIdx + pointCount * 16);
        var xx = part[0],
            yy = part[1];
        for (var j=0, len=xx.length; j<len; j++) {
          bin.writeFloat64(xx[j]);
          bin.writeFloat64(yy[j]);
        }
        pointCount += j;
      });
      if (data.pointCount != pointCount)
        error("Shp record point count mismatch; pointCount:"
          , pointCount, "data.pointCount:", data.pointCount);
    }

  }

  if (!bin) {
    bin = new BinArray(12, false)
      .writeInt32(id)
      .writeInt32(2)
      .littleEndian()
      .writeInt32(0);
  }

  return {bounds: bounds, buffer: bin.buffer()};
};
