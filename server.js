const { spawn } = require("child_process");
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5050;
app.use(express.static("public"));
const server = app.listen(PORT, () => console.log(`running on port ${PORT}`));

// SSE clients storage
const sseClients = new Set();

const AGGREGATED_FILE = path.join(__dirname, "aggregated.json"); // Aggregated by 10 minutes

// ===== Load history from files =====
const targets = {
  "1.1.1.1": {
    recentData: [], // Last 10 minutes (sliding window)
    aggregatedData: [], // Aggregated by 30 minutes
    gaps: [],
    received: 0,
    lost: 0,
    lastSeq: null,
    seqOffset: 0,
    firstPingReceived: false,
    lastAggregationTime: null // Track last aggregation timestamp
  },
  "192.168.1.1": {
    recentData: [],
    aggregatedData: [],
    gaps: [],
    received: 0,
    lost: 0,
    lastSeq: null,
    seqOffset: 0,
    firstPingReceived: false,
    lastAggregationTime: null
  }
};

if (fs.existsSync(AGGREGATED_FILE)) {
  try {
    const fileContent = fs.readFileSync(AGGREGATED_FILE, "utf-8").trim();
    if (fileContent) {
      const json = JSON.parse(fileContent);
      Object.keys(json.targets || {}).forEach(ip => {
        if (targets[ip]) {
          targets[ip].aggregatedData = json.targets[ip].aggregatedData || [];
          targets[ip].gaps = json.targets[ip].gaps || [];
          targets[ip].received = json.targets[ip].received || 0;
          targets[ip].lost = json.targets[ip].lost || 0;
          
          if (targets[ip].aggregatedData.length > 0) {
            const lastAgg = targets[ip].aggregatedData[targets[ip].aggregatedData.length - 1];
            targets[ip].lastAggregationTime = lastAgg.timestamp;
            // Set lastSeq from last aggregated point
            targets[ip].lastSeq = lastAgg.seq;
            targets[ip].seqOffset = lastAgg.seq;
          }
        }
      });
      console.log(`Loaded aggregated data from aggregated.json`);
    }
  } catch (e) {
    console.error("Error reading aggregated file:", e.message);
  }
}

// ===== Aggregate and save to aggregated file (every 10 minutes) =====
function aggregateAndSave() {
  const now = Date.now();
  const aggregationInterval = 10 * 60 * 1000; // 10 minutes
  
  Object.keys(targets).forEach(ip => {
    const target = targets[ip];
    
    // Round down to nearest 10-minute interval
    // If now is 10:15, we aggregate data from 10:00-10:10 (the interval that just ended)
    const currentIntervalStart = Math.floor(now / aggregationInterval) * aggregationInterval;
    const previousIntervalStart = currentIntervalStart - aggregationInterval;
    const previousIntervalEnd = currentIntervalStart;
    
    // Filter data that belongs to the previous interval (the one we're aggregating)
    const dataToAggregate = target.recentData.filter(p => 
      p.timestamp && p.timestamp >= previousIntervalStart && p.timestamp < previousIntervalEnd
    );
    
    if (dataToAggregate.length === 0) {
      // No data to aggregate, but still clear old data
      target.recentData = target.recentData.filter(p => 
        !p.timestamp || p.timestamp >= currentIntervalStart
      );
      return;
    }
    
    // Check if this interval already exists
    const exists = target.aggregatedData.some(agg => agg.timestamp === previousIntervalStart);
    if (exists) {
      // If interval exists, update it with new data
      const existingIndex = target.aggregatedData.findIndex(agg => agg.timestamp === previousIntervalStart);
      const existing = target.aggregatedData[existingIndex];
      
      // Combine existing aggregated data with new recent data
      const allRtts = [];
      if (existing.rtt !== null && existing.rtt !== undefined) {
        allRtts.push(existing.rtt);
      }
      dataToAggregate.forEach(point => {
        if (point.rtt !== null && point.rtt !== undefined) {
          allRtts.push(point.rtt);
        }
      });
      
      target.aggregatedData[existingIndex] = {
        seq: dataToAggregate[0]?.seq || existing.seq,
        rtt: allRtts.length > 0 
          ? Number((allRtts.reduce((a, b) => a + b, 0) / allRtts.length).toFixed(2))
          : null,
        timestamp: previousIntervalStart,
        aggregated: true
      };
    } else {
      // Create new aggregated point
      const validRtts = dataToAggregate
        .filter(p => p.rtt !== null && p.rtt !== undefined)
        .map(p => p.rtt);
      
      target.aggregatedData.push({
        seq: dataToAggregate[0]?.seq || target.lastSeq || 0,
        rtt: validRtts.length > 0 
          ? Number((validRtts.reduce((a, b) => a + b, 0) / validRtts.length).toFixed(2))
          : null,
        timestamp: previousIntervalStart,
        aggregated: true
      });
      target.aggregatedData.sort((a, b) => a.timestamp - b.timestamp);
    }
    
    // Clear aggregated data from recentData (keep only data from current interval)
    target.recentData = target.recentData.filter(p => 
      !p.timestamp || p.timestamp >= currentIntervalStart
    );
    target.lastAggregationTime = previousIntervalStart;
  });
  
  // Save aggregated data with stats
  const aggregatedData = {
    targets: {
      "1.1.1.1": {
        aggregatedData: targets["1.1.1.1"].aggregatedData,
        gaps: targets["1.1.1.1"].gaps,
        received: targets["1.1.1.1"].received,
        lost: targets["1.1.1.1"].lost
      },
      "192.168.1.1": {
        aggregatedData: targets["192.168.1.1"].aggregatedData,
        gaps: targets["192.168.1.1"].gaps,
        received: targets["192.168.1.1"].received,
        lost: targets["192.168.1.1"].lost
      }
    }
  };
  fs.writeFile(AGGREGATED_FILE, JSON.stringify(aggregatedData), err => {
    if (err) console.error("Error saving aggregated data:", err);
    else console.log("Aggregated and saved data to aggregated.json");
  });
}

// Aggregate and save every 10 minutes
setInterval(aggregateAndSave, 10 * 60 * 1000);

// ===== Ping logic =====
const ping1 = spawn("ping", ["1.1.1.1"]);
const ping2 = spawn("ping", ["192.168.1.1"]);

function broadcast(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(message);
    } catch (err) {
      console.error("Error sending SSE message:", err);
      sseClients.delete(res);
    }
  }
}

function handlePingData(ip, data) {
  const line = data.toString().trim();
  const now = Date.now();
  const target = targets[ip];

  let ok = line.match(/icmp_seq=(\d+).*time=([\d.]+)/);
  if (ok) {
    const pingSeq = Number(ok[1]);
    const rtt = Number(ok[2]);

    // On first ping after restart, set offset to continue sequence
    if (!target.firstPingReceived) {
      if (target.lastSeq !== null) {
        // Continue from last seq, ping starts at 1, so offset = lastSeq
        target.seqOffset = target.lastSeq;
      }
      target.firstPingReceived = true;
    }

    // Normalize seq to continue from history
    const seq = target.seqOffset + pingSeq;

    if (target.lastSeq !== null && seq !== target.lastSeq + 1) {
      const miss = seq - target.lastSeq - 1;
      target.lost += miss;
      target.gaps.push({ from: target.lastSeq + 1, to: seq - 1, count: miss });
    }

    target.lastSeq = seq;
    target.received++;

    const point = { seq, rtt, timestamp: now };
    target.recentData.push(point);
    
    // Keep only last 10 minutes in memory (sliding window)
    const tenMinutesAgo = now - 10 * 60 * 1000;
    target.recentData = target.recentData.filter(p => !p.timestamp || p.timestamp >= tenMinutesAgo);

    // Calculate average RTT from all data (recent + aggregated)
    const allData = [...target.aggregatedData, ...target.recentData];
    const validRtts = allData.filter(p => p.rtt !== null && p.rtt !== undefined).map(p => p.rtt);
    const avgRtt = validRtts.length > 0 
      ? (validRtts.reduce((a, b) => a + b, 0) / validRtts.length).toFixed(2)
      : 0;

    broadcast({
      type: "ping",
      target: ip,
      received: target.received,
      lost: target.lost,
      lossPercent: (target.lost / (target.received + target.lost)) * 100,
      avgRtt: avgRtt,
      gaps: target.gaps,
      point
    });
    return;
  }

  let unreach = line.match(/icmp_seq=(\d+)/);
  if (unreach) {
    const pingSeq = Number(unreach[1]);

    // On first ping after restart, set offset to continue sequence
    if (!target.firstPingReceived) {
      if (target.lastSeq !== null) {
        target.seqOffset = target.lastSeq;
      }
      target.firstPingReceived = true;
    }

    // Normalize seq to continue from history
    const seq = target.seqOffset + pingSeq;

    target.lost++;
    target.gaps.push({ from: seq, to: seq, count: 1 });
    target.lastSeq = seq;
    target.recentData.push({ seq, rtt: null, timestamp: now });
    
    // Keep only last 10 minutes in memory (sliding window)
    const tenMinutesAgo = now - 10 * 60 * 1000;
    target.recentData = target.recentData.filter(p => !p.timestamp || p.timestamp >= tenMinutesAgo);

    // Calculate average RTT from all data (recent + aggregated)
    const allData = [...target.aggregatedData, ...target.recentData];
    const validRtts = allData.filter(p => p.rtt !== null && p.rtt !== undefined).map(p => p.rtt);
    const avgRtt = validRtts.length > 0 
      ? (validRtts.reduce((a, b) => a + b, 0) / validRtts.length).toFixed(2)
      : 0;

    broadcast({
      type: "loss",
      target: ip,
      received: target.received,
      lost: target.lost,
      lossPercent: (target.lost / (target.received + target.lost)) * 100,
      avgRtt: avgRtt,
      gaps: target.gaps,
      point: { seq, rtt: null, timestamp: now }
    });
  }
}

ping1.stdout.on("data", (data) => handlePingData("1.1.1.1", data));
ping2.stdout.on("data", (data) => handlePingData("192.168.1.1", data));

// ===== Calculate average RTT helper =====
function calculateAvgRtt(target) {
  const allData = [...target.aggregatedData, ...target.recentData];
  const validRtts = allData.filter(p => p.rtt !== null && p.rtt !== undefined).map(p => p.rtt);
  return validRtts.length > 0 
    ? (validRtts.reduce((a, b) => a + b, 0) / validRtts.length).toFixed(2)
    : 0;
}

// ===== Combine recent and aggregated data for client =====
function getCombinedHistoryData(target) {
  // Combine aggregated data + recent data, sorted by timestamp/seq
  const combined = [...target.aggregatedData, ...target.recentData].sort((a, b) => {
    if (a.timestamp && b.timestamp) return a.timestamp - b.timestamp;
    return a.seq - b.seq;
  });
  return combined;
}

// ===== SSE endpoint =====
app.get("/events", (req, res) => {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Add client to set
  sseClients.add(res);

  // Send initial history (combined recent + aggregated)
  res.write(`data: ${JSON.stringify({ 
    type: "history", 
    targets: {
      "1.1.1.1": {
        historyData: getCombinedHistoryData(targets["1.1.1.1"]),
        gaps: targets["1.1.1.1"].gaps,
        received: targets["1.1.1.1"].received,
        lost: targets["1.1.1.1"].lost,
        avgRtt: calculateAvgRtt(targets["1.1.1.1"])
      },
      "192.168.1.1": {
        historyData: getCombinedHistoryData(targets["192.168.1.1"]),
        gaps: targets["192.168.1.1"].gaps,
        received: targets["192.168.1.1"].received,
        lost: targets["192.168.1.1"].lost,
        avgRtt: calculateAvgRtt(targets["192.168.1.1"])
      }
    }
  })}\n\n`);

  // Handle client disconnect
  req.on("close", () => {
    sseClients.delete(res);
    res.end();
  });
});
