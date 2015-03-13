/**
 * @file Several functions that handle test-running and statistics collection.
 */

'use strict';

var locations = require( './locations.json' );
var querystring = require( 'querystring' );
var supertest = require( 'supertest' );
var util = require( 'util' );

/**
 * Return a boolean indicating whether `actual` has all the key value pairs
 * contained in `expected`.
 */
function equalProperties( expected, actual ){
  for( var prop in expected ){
    if( actual[ prop ] !== expected[ prop ] ){
      return false;
    }
  }
  return true;
}

/**
 * Given a test-case, the API results for the input it specifies, and a
 * priority-threshold to find the results in, return an object indicating the
 * status of this test (whether it passed, failed, is a placeholder, etc.)
 */
function evalTest( priorityThresh, testCase, apiResults ){
  if( !( 'expected' in testCase ) && !( 'unexpected' in testCase ) ){
    return {
      result: 'placeholder',
      msg: 'Placeholder test, no `expected` specified.'
    };
  }

  var expected = [];
  var expectedPriorityThresh = priorityThresh;
  if( 'expected' in testCase ){
    for( var ind = 0; ind < testCase.expected.properties.length; ind++ ){
      var testCaseProps = testCase.expected.properties[ ind ];
      if( typeof testCaseProps === 'string' ){
        if( testCaseProps in locations ){
          expected.push(locations[ testCaseProps ]);
        }
        else {
          return {
            result: 'placeholder',
            msg: 'Placeholder test, no `out` object matches in `locations.json`.'
          }
        }
      }
      else {
        expected.push( testCaseProps );
      }
    }

    if( 'priorityThresh' in testCase.expected ){
      expectedPriorityThresh = testCase.expected.priorityThresh;
    }
  }

  var unexpected = ( testCase.hasOwnProperty( 'unexpected' ) ) ?
    testCase.unexpected.properties : [];
  var expectedResultFound = false;

  for( var ind = 0; ind < apiResults.length; ind++ ){
    var result = apiResults[ ind ];
    for( var expectedInd = 0; expectedInd < expected.length; expectedInd++ ){
      if( !expectedResultFound &&
        equalProperties( expected[ expectedInd ], result.properties ) ){
        var success = ( ind + 1 ) <= priorityThresh;
        if( !success ){
          return {
            result: 'fail',
            msg: util.format( 'Result found, but not in top %s.', priorityThresh )
          }
        }
        else {
          expectedResultFound = true;
        }
      }
    }

    for( var unexpectedInd = 0; unexpectedInd < unexpected.length; unexpectedInd++ ){
      if( equalProperties( unexpected[ unexpectedInd ], result.properties ) ){
        return {
          result: 'fail',
          msg: util.format( 'Unexpected result found.' )
        }
      }
    }
  }

  return ( expectedResultFound || (expected.length === 0 && unexpected.length > 0 ) ) ?
    { result: 'pass' } :
    {
      result: 'fail',
      msg: 'No result found.'
    };
}

var validTestStatuses = [ 'pass', 'fail', undefined ];
/**
 * Execute all the tests in a test-suite file with `evalTest()`, and pass an
 * object containing the results to `cb()`. `apiUrl` contains the URL of the
 * Pelias API to query.
 */
function execTestSuite( apiUrl, testSuite, cb ){
  var testResults = {
    stats: {
      pass: 0,
      fail: 0,
      placeholder: 0,
      regression: 0,
      timeTaken: null,
      name: testSuite.name
    },
    results: []
  };

  testSuite.tests.forEach( function ( testCase ){
    if( validTestStatuses.indexOf( testCase.status ) === -1 ){
      console.error( util.format(
        'Invalid test status: `%s`. Recognized statuses are: %s',
        testCase.status, JSON.stringify( validTestStatuses )
      ));
      process.exit( 1 );
    }
  });

  var startTime = new Date().getTime();
  testSuite.tests.forEach( function ( testCase ){
    supertest( apiUrl )
      .get( '/search?' + querystring.stringify( testCase.in ) )
      .expect( 'Content-Type', /json/ )
      .expect( 200 )
      .end( function ( err, res ) {
        if( err ){
          throw err;
        }

        stats.testsCompleted++;
        process.stderr.write( util.format(
          '\rTests completed: %s/%s', stats.testsCompleted.toString().bold,
          stats.testsTotal
        ));

        var results = evalTest( testSuite.priorityThresh, testCase, res.body.features );
        if( results.result === 'pass' && testCase.status === 'fail' ){
          results.progress = 'improvement';
        }
        else if( results.result === 'fail' && testCase.status === 'pass' ){
          testResults.stats.regression++;
          results.progress = 'regression';
        }

        results.testCase = testCase;
        testResults.stats[ results.result ]++;
        testResults.results.push( results );

        if( testResults.results.length === testSuite.tests.length ){
          testResults.stats.timeTaken = new Date().getTime() - startTime;

          /**
           * Sort the test-cases by id to force some output uniformity across
           * test-runs (since otherwise it'd depend entirely on when a given
           * request returned, and would be effectively random). Separate and
           * sort string/number ids separately.
           */
          testResults.results.sort( function ( a, b ){
            var isAStr = typeof a.testCase.id === 'string';
            var isBStr = typeof b.testCase.id === 'string';
            if( ( isAStr && isBStr ) || ( !isAStr && !isBStr ) ){
              return a.testCase.id > b.testCase.id ? 1 : -1;
            }
            else if( isAStr ){
              return 1;
            }
            else {
              return -1;
            }
          });
          cb( testResults );
        }
      });
  });
}

var stats = {
  testsCompleted: 0,
  testsTotal: 0
};

/**
 * Asynchronously execute the given `testSuites` against the Pelias API running
 * at `apiUrl`, and pass the results to the `outputGenerator` function.
 */
function execTestSuites( apiUrl, testSuites, outputGenerator ){
  var suiteResults = {
    stats: {
      pass: 0,
      fail: 0,
      placeholder: 0,
      regression: 0,
      timeTaken: 0,
      url: apiUrl
    },
    results: []
  };

  testSuites.map( function ( suite ){
    stats.testsTotal += suite.tests.length;
    execTestSuite( apiUrl, suite, function ( testResults ){
      suiteResults.results.push( testResults );

      [ 'pass', 'fail', 'placeholder', 'timeTaken', 'regression' ].forEach( function ( propName ){
        suiteResults.stats[ propName ] += testResults.stats[ propName ];
      });

      if( suiteResults.results.length === testSuites.length ){
        process.stdout.write( '\r' ); // Clear the test-completion counter from the terminal.
        outputGenerator( suiteResults );
      }
    });
  });
}

module.exports = execTestSuites;
