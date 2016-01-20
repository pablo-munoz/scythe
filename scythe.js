#! /usr/bin/env node

// +++ Dependencies
var fse       = require('fs-extra');
var path      = require('path');
var nunjucks  = require('nunjucks');
var highlight = require('highlight.js');
var yaml      = require('js-yaml');
var _         = require('lodash');
var q         = require('q');
var program   = require('commander');
var promptly  = require('promptly');
// --- Dependencies


// +- CONFIG_FILENAME
var CONFIG_FILENAME = '_config.yml';

// +- MODULE_ROOT
var MODULE_ROOT = path.dirname(__filename);

// +- FILE_TYPE_...
var FILE_TYPE_SPECIAL = 'SPECIAL';
var FILE_TYPE_PAGE = 'PAGE';
var FILE_TYPE_VERBATIM = 'VERBATIM';

// +- CODE_REGION_REGEX
var CODE_REGION_REGEX = _.mapValues(
    fse.readJsonSync(path.join(MODULE_ROOT, 'languages.json')), function(obj) {
        return new RegExp([
            '[^\\S\\n]*',                     // Zero or more spaces
            obj.symbol,                       // Comment syntax
            '[^\\S\\n]*',                     // Zero or more sapces
            '\\+{3}',                         // Three consecutive plus symbols
            '[^\\S\\n]*',                     // Zero or more spaces
            '(.+)',                           // The name of the reference (capture)
            '\\n',                            // Newline
            '([\\s\\S]+)\\n',                 // The actual code (capture),
            '[^\\S\\n]*',                     // Zero or more spaces
            obj.symbol,                       // Comment syntax
            '[^\\S\\n]*',                     // Zero or more spaces
            '\\-{3}',                         // Three consecutive minus symbols
            '[^\\S\\n]*',                     // Zero or more spaces
            '\\1',                            // Same name region name of the beginning comment
        ].join(''), 'g')
    });

// +- SIMPLE_CODE_REGION_REGEX
var SIMPLE_CODE_REGION_REGEX = _.mapValues(
    fse.readJsonSync(path.join(MODULE_ROOT, 'languages.json')), function(obj) {
        return new RegExp([
            '[^\\S\\n]*',
            obj.symbol,                       // Comment syntax
            '[^\\S\\n]*',                     // Zero or more spaces
            '\\+\\-',                         // Three consecutive plus symbols
            '[^\\S\\n]*',                     // Zero or more spaces
            '(.+)',                           // The name of the reference (capture)
            '\\n',                            // Newline
            '([\\s\\S]+?)\\n\\n',             // The code (capture),
        ].join(''), 'g')
    });



// +++ fn main
function main() {
    consoleMessage('log', 'Static site generation started.');
    consoleMessage('log', 'Getting site configuration.');
    getConfiguration()
        .then(function(config) {
            fse.emptyDirSync(config.outputDir);
            parseFiles(config)
                .then(function(parsedFiles) {
                    return makeSite(parsedFiles, config)
                        .catch(function(err) { consoleMessage('error', err); });
                })
                .then(function() {
                    consoleMessage('log', 'Static site generation finished.');
                })
                .catch(function(err) {
                    consoleMessage('error', err);
                });
        })
        .catch(function(err) {
            consoleMessage('error', err);
        });

}
// --- fn main


// +++ getConfiguration()
function getConfiguration() {
    var deferred = q.defer();

    var config = {};

    fse.readFile(CONFIG_FILENAME, 'utf-8', function(err, content) {
        if (err) {
            consoleMessage('warn', 'Configuration file not found, using defaults.');
        } else {
            try {
                _.extend(config, yaml.safeLoad(content));
            } catch(err) {
                consoleMessage('error', 'Could not parse configuration file, using defaults.');
            }
        }

        _.defaults(config, {
            inputDirAbsPath: path.resolve('.'),
            outputDir: '_site',
            codeDir: '..'
        });

        deferred.resolve(config);
    });

    return deferred.promise;
}
// --- getConfiguration()



// +++ parseFiles()
function parseFiles(config) {
    var deferred = q.defer();

    var SPECIAL_FILES_LIST = [
        '_config.yml',
        '_data',
        '_layouts',
        '_includes',
        config.outputDir
    ];

    var parsedFiles = [];

    fse.walk('.')
        .on('data', function(fileDesc) {
            fileDesc.pathRelativeToInputDir = path.relative(
                config.inputDirAbsPath, fileDesc.path);
            fileDesc.pathRelativeToOutputDir = path.join(
                config.outputDir, fileDesc.pathRelativeToInputDir);
            fileDesc.absoluteInputPath = fileDesc.path;
            fileDesc.absoluteOutputPath = path.join(
                config.inputDirAbsPath, fileDesc.pathRelativeToOutputDir);
            fileDesc.category = categorizeFile(fileDesc.pathRelativeToInputDir);
            parsedFiles.push(fileDesc);
        })
        .on('end', function() {
            deferred.resolve(parsedFiles);
        });

    return deferred.promise;

    // +++ categorizeFile()
    function categorizeFile(filepath) {
        if (filepathIsSpecial(filepath)) {
            return FILE_TYPE_SPECIAL;
        }
        else if (filepathIsPage(filepath)) {
            return FILE_TYPE_PAGE;
        }
        else {
            return FILE_TYPE_VERBATIM;
        }
    }
    // --- categorizeFile()

    // +++ filepathIsSpecial()
    function filepathIsSpecial(filepath) {
        var root = filepath.split(path.sep)[0];
        return _.contains(SPECIAL_FILES_LIST, root);
    }
    // --- filepathIsSpecial()

    // +++ filepathIsPage()
    function filepathIsPage(filepath) {
        return path.extname(filepath) === '.html';
    }
    // --- filepathIsPage()
}
// --- parseFiles()



// +++ makeSite()
function makeSite(parsedFiles, config) {
    var deferred = q.defer();

    // +- template engine instatiation
    var engine = new nunjucks.Environment(
        [new nunjucks.FileSystemLoader(path.join(MODULE_ROOT, 'html')),
         new nunjucks.FileSystemLoader(config.absoluteInputPath)]);

    // +- engine globals extension
    _.extend(engine.globals, {
        highlight: highlight,
        makeCodeRegionHtml: makeCodeRegionHtml
    });

    // +- code regions store
    var codeRegions = {};

    // +- template engine context
    var context = {
        data: parseDataDir(),
    };

    // +- makeSite main loop
    _.each(parsedFiles, function(fileDesc) {
        switch (fileDesc.category) {
        case FILE_TYPE_VERBATIM:
            if (fileDesc.stats.isDirectory()) {
                fse.mkdirpSync(fileDesc.absoluteOutputPath);
            }
            else {
                fse.ensureDirSync(path.dirname(fileDesc.absoluteOutputPath));
                fse.copySync(fileDesc.absoluteInputPath, fileDesc.absoluteOutputPath);
            }
            break;
        case FILE_TYPE_PAGE:
            try {
                consoleMessage('log', '\nRendering page-type file "' + fileDesc.pathRelativeToInputDir + '"');
                var rawHTML = fse.readFileSync(fileDesc.absoluteInputPath, 'utf-8');
                var renderedHTML = engine.renderString(rawHTML, context);
                fse.writeFileSync(fileDesc.absoluteOutputPath, renderedHTML);
                consoleMessage('log', 'OK');
            } catch (err) {
                consoleMessage('error', err.toString());
            }
            break;
        case FILE_TYPE_SPECIAL:
            // DO NOTHING
            break;
        default:
            consoleMessage('error', 'Unexpected file type "' + fileDesc.category + '" of file "' + fileDesc.pathRelativeToInputDir +'"');
        }
    });

    deferred.resolve();

    return deferred.promise;

    // +++ parseDataDir()
    function parseDataDir() {
        var dataFiles;

        try {
            dataFiles = fse.readdirSync('_data');
        } catch(err) {
            // Do nothing
        }

        var data = {};

        _.each(dataFiles, function(file) {
            if (!(path.extname(file) === '.yml')) return;
            try {
                data[path.basename(file, '.yml')] = yaml.safeLoad(fse.readFileSync(path.join('_data', file)));
            } catch(err) {
                consoleMessage('error', 'Error! Could not open or parse data file "' + file + '".');
            }
        });
        return data;
    }
    // --- parseDataDir()

    // +++ getCodeRegion()
    function getCodeRegion(name, file) {
        if (_.isUndefined(codeRegions[file])) {
            codeRegions[file] = getCodeRegionsOfFile(file);
        }

        var referencedCode = _.get(codeRegions, [file, name], undefined);
        var errorMessage = 'ERROR! Code region "' + name + '" of file "' + file + '" not found.'

        if (_.isUndefined(referencedCode)) {
            consoleMessage('error', errorMessage);
            return errorMessage;
        }

        return referencedCode;
    }
    // --- getCodeRegion()

    // +++ getCodeRegionsOfFile()
    function getCodeRegionsOfFile(file) {
        var ext = path.extname(file);
        var reBlock = CODE_REGION_REGEX[ext];
        var reSimple = SIMPLE_CODE_REGION_REGEX[ext];
        var content = '';
        var regions = {};

        try {
            content = fse.readFileSync(path.join(config.codeDir, file), 'utf-8');
        } catch(err) {
            // DO NOTHING;
        }

        while ((match = reBlock.exec(content))) {
            var name = match[1];
            var code = match[2];
            regions[name] = code;
            // +- getCodeRegionsOfFile recursive region enabler
            reBlock.lastIndex =
                reBlock.lastIndex - (match[0].length - match[0].split(/[\n\r]/)[0].length) + 1;

        }
        
        while ((match = reSimple.exec(content))) {
            var name = match[1];
            var code = match[2];
            regions[name] = code;
        }

        return regions;
    }
    // --- getCodeRegionsOfFile()

    // +++ makeCodeRegionHtml()
    function makeCodeRegionHtml(name, file) {
        var lang = path.extname(file).slice(1);
        if (lang == 'jsx') lang = 'js';
        var code = getCodeRegion(name, file);
        return highlight.highlight(lang, code).value;
    }
    // --- makeCodeRegionHtml()
}
// --- makeSite()



// +++ consoleMessage()
function consoleMessage(type, message) {
    var promptedMessage = 'scythe> ' + message.split(/[\n\r]/).join('\nscythe> ');
    console[type](promptedMessage);
}
// --- consoleMessage()



// +++ copyBootstrapTemplate()
function copyBootstrapTemplate() {
    fse.stat('docs', function(err, stats) {
        if (!err && stats.isDirectory()) {
            promptly.confirm('Dir "docs" already exists, continuing will delete it first. Continue? (y/n) ', function(err, confirmed) {
                if (confirmed) {
                    fse.removeSync('docs');
                    fse.copySync(path.join(MODULE_ROOT, 'bootstrap_template'), 'docs');
                }
            });
        } else {
            fse.copySync(path.join(MODULE_ROOT, 'bootstrap_template'), 'docs');
        }
    });
}
// --- copyBootstrapTemplate()


// +- cli configuration
program
    .version('0.1.0');

// +- cli mksite cmd
program
    .command('mksite')
    .description('Makes a static site out of the files in the cwd.')
    .action(main);

// +- cli mktemplate cmd
program
    .command('mktemplate')
    .description('Creates a "docs" directory with boilerplate.')
    .action(copyBootstrapTemplate)

program.parse(process.argv);
