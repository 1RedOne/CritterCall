// animalese.js
// (C) 2014 Josh Simmons
// http://github.com/acedio/animalese.js

// Critter Call: report load failures rather than leaving playback pending.
var Animalese = function(letters_file, onload, onerror) {
  this.Animalese = function(script, shorten, pitch) {
    function shortenWord(str) {
      if (str.length > 1) {
        return str[0] + str[str.length - 1];
      }
      return str;
    }

    var processed_script = script;
    if (shorten) {
      processed_script =
          script.replace(/[^a-z]/gi, ' ').split(' ').map(shortenWord).join('');
    }

    var data = [];

    var sample_freq = 44100;
    var library_letter_secs = 0.15;
    var library_samples_per_letter =
        Math.floor(library_letter_secs * sample_freq);
    var output_letter_secs = 0.075;
    var output_samples_per_letter =
        Math.floor(output_letter_secs * sample_freq);

    for (var c_index = 0; c_index < processed_script.length; c_index++) {
      var c = processed_script.toUpperCase()[c_index];
      if (c >= 'A' && c <= 'Z') {
        var library_letter_start =
            library_samples_per_letter * (c.charCodeAt(0) - 'A'.charCodeAt(0));

        for (var i = 0; i < output_samples_per_letter; i++) {
          data[c_index * output_samples_per_letter + i] =
              this.letter_library[44 + library_letter_start + Math.floor(i * pitch)];
        }
      } else { // non pronouncable character or space
        for (var i = 0; i < output_samples_per_letter; i++) {
          data[c_index * output_samples_per_letter + i] = 127;
        }
      }
    }

    var wave = new RIFFWAVE();
    wave.header.sampleRate = sample_freq;
    wave.header.numChannels = 1;
    wave.Make(data);

    return wave;
  }

  var xhr = new XMLHttpRequest();
  xhr.open('GET', letters_file);
  xhr.responseType = 'arraybuffer';
  xhr.timeout = 10000;
  var req = this;
  xhr.onload = function(e) {
    if (this.status !== 200 || !this.response || this.response.byteLength < 172034) {
      onerror(new Error('Animalese audio bank is missing or invalid.'));
      return;
    }
    req.letter_library = new Uint8Array(this.response);
    onload();
  }
  xhr.onerror = xhr.ontimeout = function() {
    onerror(new Error('Could not load the local Animalese audio bank.'));
  };
  xhr.send();
}
