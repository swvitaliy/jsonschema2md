let path = require('path');
let _items = {};

exports.set = (key, val) => _items[key] = val;
exports.get = key => _items[key];

exports.set('templatePath', path.resolve('../templates/md'));
