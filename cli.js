#! /usr/bin/env node
/**
 * Copyright 2017 Adobe Systems Incorporated. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

var logger = require('winston');
var Promise = require('bluebird');
var path = require('path');
var _ = require('lodash');
var fs = Promise.promisifyAll(require('fs'));
var readdirp = require('readdirp');
var Ajv = require('ajv');

var Schema = require('./lib/schema');
var readSchemaFile = require('./lib/readSchemaFile');

// parse/process command line arguments
var argv = require('optimist')
  .usage('Generate Markdown documentation from JSON Schema.\n\nUsage: $0')
  .demand('d')
  .alias('d', 'input')
  // TODO: is baseURL still a valid parameter?
  .describe('d', 'path to directory containing all JSON Schemas or a single JSON Schema file. This will be considered as the baseURL. By default only files ending in .schema.json will be processed, unless the schema-extension is set with the -e flag.')
  .alias('o', 'out')
  .describe('o', 'path to output directory')
  .default('o', path.resolve(path.join('.', 'out')))
  .alias('m', 'meta')
  .describe('m', 'add metadata elements to .md files Eg -m template=reference. Multiple values can be added by repeating the flag Eg: -m template=reference -m hide-nav=true')
  .alias('t', 'templates')
  .describe('t', 'path to template directory')
  .alias('s', 'metaSchema')
  .describe('s', 'Custom meta schema path to validate schemas')
  .alias('x', 'schema-out')
  .describe('x', 'output JSON Schema files including description and validated examples in the _new folder at output directory, or suppress with -')
  .alias('e', 'schema-extension')
  .describe('e', 'JSON Schema file extension eg. schema.json or json')
  .alias('n', 'no-readme')
  .describe('n', 'Do not generate a README.md file in the output directory')
  .describe('link-*', 'Add this file as a link the explain the * attribute, e.g. --link-abstract=abstract.md')
  .check(function(args) {
    if (!fs.existsSync(args.input)) {
      throw 'Input file "' + args.input + '" does not exist!';
    }
    if (args.s && !fs.existsSync(args.s)) {
      throw 'Meta schema file "' + args.s + '" does not exist!';
    }
  })
  .argv;

const docs = _.fromPairs(_.toPairs(argv).filter(([ key, value ]) => { return key.startsWith('link-'); }).map(([ key, value ]) => { return [ key.substr(5), value ];}));

var ajv = new Ajv({ allErrors: true, messages:true });
ajv.addMetaSchema(require('ajv/lib/refs/json-schema-draft-04.json'));
var schemaPathMap = {};
var metaElements = {};
var schemaPath = path.resolve(argv.d);
var outDir = path.resolve(argv.o);
var schemaDir = argv.x === '-' ? '' : argv.x ? path.resolve(argv.x) : outDir;
var target = fs.statSync(schemaPath);
const readme = argv.n !== true;
const schemaExtension = argv.e || 'schema.json';

require('./lib/options').set('templatePath', path.resolve(argv.t || './templates/md'));
//console.log('templatePath %s', require('./lib/options').get('templatePath'));

if (argv.s){
  ajv.addMetaSchema(require(path.resolve(argv.s)));
}

if (argv.m) {
  if (_.isArray(argv.m)){
    _.each(argv.m, function(item){
      var meta=item.split('=');
      if (meta.length === 2) {
        metaElements[meta[0]] = meta[1];
      }
    });
  } else {
    var meta=(argv.m).split('=');
    if (meta.length === 2) {
      metaElements[meta[0]] = meta[1];
    }
  }
}

logger.info('output directory: %s', outDir);
if (target.isDirectory()) {
  // the ajv json validator will be passed into the main module to help with processing
  var files=[];
  readdirp({ root: schemaPath, fileFilter: `*.${schemaExtension}` })
    .on('data', entry => {
      files.push(entry.fullPath);
      try {
        ajv.addSchema(require(entry.fullPath), entry.fullPath);
      } catch (e){
        logger.error('Ajv processing error for schema at path %s', entry.fullPath);
        logger.error(e);
        process.exit(1);
      }
    })
    .on('end', () => {
      Schema.setAjv(ajv);
      Schema.setSchemaPathMap(schemaPathMap);
      return Promise.reduce(files, readSchemaFile, schemaPathMap)
        .then(schemaMap => {
          logger.info('finished reading all *.%s files in %s, beginning processing….', schemaExtension, schemaPath);
          return Schema.process(schemaMap, schemaPath, outDir, schemaDir, metaElements, readme, docs);
        })
        .then(() => {
          logger.info('Processing complete.');
        })
        .catch(err => {
          logger.error(err);
          process.exit(1);
        });
    })
    .on('error', err => {
      logger.error(err);
      process.exit(1);
    });
} else {
  readSchemaFile(schemaPathMap, schemaPath)
    .then(schemaMap => {
      ajv.addSchema(require(schemaPath), schemaPath);
      Schema.setAjv(ajv);
      Schema.setSchemaPathMap(schemaPathMap);
      logger.info('finished reading %s, beginning processing....', schemaPath);
      return Schema.process(schemaMap, schemaPath, outDir, schemaDir, metaElements, false, docs);
    })
    .then(() => {
      logger.info('Processing complete.');
    })
    .catch(err => {
      logger.error(err);
      process.exit(1);
    });
}
