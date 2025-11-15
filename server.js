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

const HISTORY_FILE = path.join(__dirname, "history.json");

// ===== Load history from file =====
const targets = {
  "1.1.1.1": {
    historyData: [],
    gaps: [],
    received: 0,
    lost: 0,
    lastSeq: null,
    seqOffset: 0,
    firstPingReceived: false
  },
  "192.168.1.1": {
    historyData: [],
    gaps: [],
    received: 0,
    lost: 0,
    lastSeq: null,
    seqOffset: 0,
    firstPingReceived: false
  }
};

if (fs.existsSync(HISTORY_FILE)) {
  try {
    const fileContent = fs.readFileSync(HISTORY_FILE, "utf-8").trim();
    
    // Skip if file is empty
    if (!fileContent) {
      console.log("History file is empty, starting fresh");
    } else {
    	const json = JSON.parse(fileContent);
		Object.keys(json.targets).forEach(ip => {
			if (targets[ip]) {
			targets[ip] = { ...targets[ip], ...json.targets[ip] };
			targets[ip].lastSeq = targets[ip].historyData.length 
				? targets[ip].historyData[targets[ip].historyData.length-1].seq 
				: null;
			// Set offset to continue sequence after restart
			if (targets[ip].lastSeq !== null) {
				targets[ip].seqOffset = targets[ip].lastSeq;
			}
			}
		});
		console.log(`Loaded history from history.json`);
    }
  } catch (e) {
    console.error("Error reading history file:", e.message);
    console.log("Starting with empty history");
  }
}

// ===== Save history to file periodically =====
function saveHistory() {
  const data = { 
    targets: {
      "1.1.1.1": {
        historyData: targets["1.1.1.1"].historyData,
        gaps: targets["1.1.1.1"].gaps,
        received: targets["1.1.1.1"].received,
        lost: targets["1.1.1.1"].lost
      },
      "192.168.1.1": {
        historyData: targets["192.168.1.1"].historyData,
        gaps: targets["192.168.1.1"].gaps,
        received: targets["192.168.1.1"].received,
        lost: targets["192.168.1.1"].lost
      }
    }
  };
  fs.writeFile(HISTORY_FILE, JSON.stringify(data), err => {
    if (err) console.error("Error saving history:", err);
  });
}
// Save every 10 seconds
setInterval(saveHistory, 10000);

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
    target.historyData.push(point);

    // Calculate average RTT
    const validRtts = target.historyData.filter(p => p.rtt !== null && p.rtt !== undefined).map(p => p.rtt);
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
    target.historyData.push({ seq, rtt: null, timestamp: now });

    // Calculate average RTT
    const validRtts = target.historyData.filter(p => p.rtt !== null && p.rtt !== undefined).map(p => p.rtt);
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
function calculateAvgRtt(historyData) {
  const validRtts = historyData.filter(p => p.rtt !== null && p.rtt !== undefined).map(p => p.rtt);
  return validRtts.length > 0 
    ? (validRtts.reduce((a, b) => a + b, 0) / validRtts.length).toFixed(2)
    : 0;
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

  // Send initial history
  res.write(`data: ${JSON.stringify({ 
    type: "history", 
    targets: {
      "1.1.1.1": {
        historyData: targets["1.1.1.1"].historyData,
        gaps: targets["1.1.1.1"].gaps,
        received: targets["1.1.1.1"].received,
        lost: targets["1.1.1.1"].lost,
        avgRtt: calculateAvgRtt(targets["1.1.1.1"].historyData)
      },
      "192.168.1.1": {
        historyData: targets["192.168.1.1"].historyData,
        gaps: targets["192.168.1.1"].gaps,
        received: targets["192.168.1.1"].received,
        lost: targets["192.168.1.1"].lost,
        avgRtt: calculateAvgRtt(targets["192.168.1.1"].historyData)
      }
    }
  })}\n\n`);

  // Handle client disconnect
  req.on("close", () => {
    sseClients.delete(res);
    res.end();
  });
});
