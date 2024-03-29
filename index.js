var _ = require("underscore");
var Twit = require("twit");

var express = require("express");
var bodyParser = require("body-parser");
var errorHandler = require("errorhandler");

var config;
try {
  config = require("./config");
} catch(e) {
  console.log("Failed to find local config, falling back to environment variables");
  config = {
    pusher_app_id: process.env.PUSHER_APP_ID,
    pusher_key: process.env.PUSHER_KEY,
    pusher_secret: process.env.PUSHER_SECRET,
    twitter_consumer_key: process.env.TWITTER_CONSUMER_KEY,
    twitter_consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
    twitter_access_token_key: process.env.TWITTER_ACCESS_TOKEN_KEY,
    twitter_access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
    keywords: (process.env.KEYWORDS) ? process.env.KEYWORDS.split(",") : [],
    update_frequency: process.env.UPDATE_FREQUENCY_SECONDS || 5,
    debug: (process.env.DEBUG === undefined? false : true)
  }
}

console.log('Starting with config', config);

var log = function() {
  if(config.debug) {
    console.log.apply(console, arguments);
  }
};

var keywords = config.keywords;

// Using a constructor for memory profiling
var KeywordStats = function() {
  var self = this;
  self.past24 = {
    total: 0,
    // Per-minute, with anything after 24-hours removed
    data: [{
      value: 0,
      time: statsTime.getTime()
    }]
  };
  self.allTimeTotal = 0;
};

// LEAK: Could it be this?
var keywordStats = {};


// --------------------------------------------------------------------
// SET UP PUSHER
// --------------------------------------------------------------------
var Pusher = require("pusher");
var pusher = new Pusher({
  appId: config.pusher_app_id,
  key: config.pusher_key,
  secret: config.pusher_secret,
  cluster: 'eu',
  host: 'api-eu.pusher.com',
  encrypted: true
});


// --------------------------------------------------------------------
// SET UP EXPRESS
// --------------------------------------------------------------------

var app = express();

// Parse application/json and application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({
  extended: true
}));
app.use(bodyParser.json());

// Ping
app.get("/ping", function(req, res) {
  res.status(200).end();
});

// Endpoint for accessing list of active keywords
app.get("/keywords.json", function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");

  res.json(keywords);
});

// Get stats for past 24 hours
app.get("/stats/:keyword/24hours.json", function(req, res, next) {
  var keyword = decodeURIComponent(req.params.keyword);
  if (!keywordStats[keyword]) {
    res.status(404).end();
    return;
  }

  // LEAK: Could it be this?
  var statsCopy = JSON.parse(JSON.stringify(keywordStats[keyword].past24.data)).reverse();

  // Pop the current minute off
  var removedStat = statsCopy.pop();

  // Reduce total to account for removed stat
  var newTotal = keywordStats[keyword].past24.total - removedStat.value;

  var output = {
    total: newTotal,
    data: statsCopy
  };

  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");

  res.json(output);

  statsCopy = undefined;
  removedStat = undefined;
  output = undefined;
});

// Get stats for past 24 hours - Geckoboard formatting
app.get("/stats/:keyword/24hours-geckoboard.json", function(req, res, next) {
  if (!keywordStats[req.params.keyword]) {
    res.status(404).end();
    return;
  }

  // LEAK: Could it be this?
  var statsCopy = JSON.parse(JSON.stringify(keywordStats[req.params.keyword].past24.data)).reverse();

  // Pop the current minute off
  var removedStat = statsCopy.pop();

  // Reduce total to account for removed stat
  var newTotal = keywordStats[req.params.keyword].past24.total - removedStat.value;

  var numbers = [];

  _.each(statsCopy, function(stat) {
    numbers.push(stat.value)
  });

  var output = {
    item: [
      {
        text: "Past 24 hours",
        value: newTotal
      },
      numbers
    ]
  };

  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");

  res.json(output);

  statsCopy = undefined;
  removedStat = undefined;
  output = undefined;
});

// Simple logger
app.use(function(req, res, next){
  log("%s %s", req.method, req.url);
  log(req.body);
  next();
});

// Open server on specified port
var port = process.env.PORT || 5010;
app.listen(port, function() {
  console.log("Starting Express server on port %d", port);
});


// --------------------------------------------------------------------
// STATS UPDATES
// --------------------------------------------------------------------

var statsTime = new Date();

// Populate initial statistics for each keyword
_.each(keywords, function(keyword) {
  if (!keywordStats[keyword]) {
    keywordStats[keyword] = new KeywordStats();
  }
});

var updateStats = function() {
  var updateFrequencyMillis = (config.update_frequency * 1000);
  var currentTime = new Date();
  var millisSinceLastUpdate = (currentTime - statsTime);
  
  log('millisSinceLastUpdate', millisSinceLastUpdate);
  
  if (millisSinceLastUpdate < updateFrequencyMillis) {
    // Wait until the update frequency millis has passed
    setTimeout(function updateStatsClosure() {
      updateStats();
    }, 1000);

    return;
  }

  // LEAK: Could it be this?
  var statsPayload = {};

  _.each(keywords, function(keyword) {
    statsPayload[keyword] = {
      time: statsTime.getTime(),
      value: keywordStats[keyword].past24.data[0].value,
      past24Total: keywordStats[keyword].past24.total,
      allTimeTotal: keywordStats[keyword].allTimeTotal
    };

    // Add new minute with a count of 0
    keywordStats[keyword].past24.data.unshift({
      value: 0,
      time: currentTime.getTime()
    });

    // Crop array to last 24 hours
    if (keywordStats[keyword].past24.data.length > 1440) {
      log("Cropping stats array for past 24 hours");

      // Crop
      var removed = keywordStats[keyword].past24.data.splice(1439);

      // Update total
      _.each(removed, function(value) {
        keywordStats[keyword].past24.total -= value;
      });
    }
  });

  log("Sending previous minute via Pusher");
  log(statsPayload);

  // Send stats update via Pusher
  // console.log(statsPayload);
  pusher.trigger("stats", "update", statsPayload);

  statsPayload = undefined;

  statsTime = currentTime;

  // heapdump.writeSnapshot("/Users/Rob/Desktop/" + Date.now() + ".heapsnapshot");

  setTimeout(function() {
    updateStats();
  }, 1000);
};

updateStats();


// --------------------------------------------------------------------
// SET UP TWITTER
// --------------------------------------------------------------------

var T = new Twit({
  consumer_key: config.twitter_consumer_key,
  consumer_secret: config.twitter_consumer_secret,
  // app_only_auth: true,
  access_token: config.twitter_access_token_key,
  access_token_secret: config.twitter_access_token_secret
});

var twitterStream;
var streamRetryCount = 0;
var streamRetryLimit = 10;
var streamRetryDelay = 1000;

var startStream = function() {
  var tracking = keywords.join(",");

  log('tracking', tracking);

  twitterStream = T.stream("statuses/filter", {
    track: tracking
  });

  twitterStream.on("tweet", function(tweet) {
    if (streamRetryCount > 0) {
      streamRetryCount = 0;
    }
    console.log(tweet.text);
    processTweet(tweet);
  });

  twitterStream.on("error", function(error) {
    console.log("Error");
    console.log(error);

    setImmediate(restartStream);
  });

  twitterStream.on("disconnect", function(response) {
    console.log("Stream end");
    setImmediate(restartStream);
  });
};

var restartingStream = false;
var restartStream = function() {
  if (restartingStream) {
    log("Aborting stream retry as it is already being restarted");
  }

  log("Aborting previous stream");
  if (twitterStream) {
    twitterStream.destroy();
    twitterStream = undefined;
  }

  streamRetryCount += 1;
  restartingStream = true;

  if (streamRetryCount >= streamRetryLimit) {
    log("Aborting stream retry after too many attempts");
    return;
  }

  setTimeout(function restartStreamClosure() {
    restartingStream = false;
    startStream();
  }, streamRetryDelay * (streamRetryCount * 2));
};

var processTweet = function(tweet) {
  console.log(tweet);
  // Look for keywords within text
  _.each(keywords, function(keyword) {
    if (tweet.text && tweet.text.toLowerCase().indexOf(keyword.toLowerCase()) > -1) {
      // log("A tweet about " + keyword);

      // Update stats
      keywordStats[keyword].past24.data[0].value += 1;
      keywordStats[keyword].past24.total += 1;
      keywordStats[keyword].allTimeTotal += 1;
    }
  });
};



// Start stream after short timeout to avoid triggering multi-connection errors
setTimeout(startStream, 2000);

// Cron Jobs
// var dailySummary = function(){
//   var status = 'Testing';

//   T.post('statuses/update', { status: status }, function(err, data, response) {
//     console.log(data)
//   });
// }

// var CronJob = require('cron').CronJob;
// new CronJob('00 30 00 * * *', function() {
//   dailySummary();
// }, null, true, 'Europe/London');
