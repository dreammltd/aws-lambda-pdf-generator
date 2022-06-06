const fs = require('fs')

const chromium = require('chrome-aws-lambda')

const FailureReason = require('@barchart/common-js/api/failures/FailureReason'),
  PrinterFailureTypes = require('./../common/api/PrinterFailureTypes')

const LambdaResponseGeneratorGzip = require('@barchart/common-node-js/aws/lambda/responses/LambdaResponseGeneratorGzip'),
  LambdaResponseGeneratorS3 = require('@barchart/common-node-js/aws/lambda/responses/LambdaResponseGeneratorS3')

const LambdaHelper = require('./../common/aws/LambdaHelper')

function base64Encode(file) {
  var bitmap = fs.readFileSync(file)
  return new Buffer(bitmap).toString('base64')
}

module.exports = (() => {
  'use strict'

  return {
    handler: (event, lambdaContext, callback) => {
      LambdaHelper.process(
        'Print quod screenshots to PDF...',
        event,
        callback,
        async (parser, responder) => {
          const logger = LambdaHelper.getLogger()

          responder.addResponseGenerators([
            new LambdaResponseGeneratorGzip(parser),
            new LambdaResponseGeneratorS3(),
          ])

          const puppeteer = chromium.puppeteer

          const body = JSON.parse(
            Buffer.from(parser.getBody(), 'base64').toString()
          )

          const source = body.source || null
          const url = body.url || null
          const settings = body.settings || null
          const ctxScript = body.ctxScript || null

          const filename = body.filename || null // const source = body.source || null;

          if (url === null) {
            return Promise.reject(
              FailureReason.from(PrinterFailureTypes.PRINT_FAILED_HTML_MISSING)
            )
          }

          const context = {}

          context.browser = null
          context.version = null

          try {
            logger.debug(`Launching headless chrome for [ ${source} ]`)

            context.browser = await puppeteer.launch({
              args: chromium.args,
              executablePath: await chromium.executablePath,
              ignoreHTTPSErrors: true,
            })

            context.version = await context.browser.version()

            logger.info(
              `Launched headless chrome [ ${context.version} ] for [ ${source} ]`
            )

            const page = await context.browser.newPage()

            page.on('console', (message) => {
              for (let i = 0; i < message.args().length; ++i) {
                logger.info(`[ ${i} ] Console: ${message.args()[i]}`)
              }
            })

            page.on('pageerror', (error) => {
              logger.error(error)
            })

            //await page.setContent(html, { waitUntil: 'networkidle0' });

            await page.goto(url, { waitUntil: 'load' })

            if (ctxScript) {
              logger.debug(
                `Evaluating ctxScript for [ ${source} ] [ ${ctxScript.length} ]`
              )
              const asyncEval = eval(`async () => {
                 ${ctxScript}
                }`)
              const evalResult = await asyncEval()
              logger.debug(`Eval finished`)
            }

            if (settings.urls) {
              let finalHtml = '<html><body>'
              page.setViewport({ width: 1024, height: 1200 })
              for (let i = 0; i < settings.urls.length; i++) {
                const suffix = settings.urls[i]
                logger.debug(`Navigating to [ ${suffix} ]`)
                await page.goto(url + suffix, { waitUntil: 'load' })
                await new Promise((resolve) => {
                  setTimeout(resolve, 2500)
                })
                const path = `/tmp/${settings.id}-${i}.png`
                logger.debug(`Screenshotting to [ path ]`)
                await page.screenshot({
                  path,
                  fullPage: true,
                })
                finalHtml += `<div style="page-break-before:always;"><img src="data:image/png;base64,${base64Encode(
                  path
                )}" /></div>`
              }
              finalHtml += `</body></html>`
              logger.debug(`Final HTML [ ${finalHtml.length} bytes ]`)
              await page.setContent(finalHtml, { waitUntil: 'load' })
              context.pdf = await page.pdf({ format: 'A4' })
            } else {
              // simply print the single page to PDF and return
              context.pdf = await page.pdf(settings || {})
            }

            logger.info(`Printed HTML layout for [ ${source} ] as PDF`)

            await page.close()
          } catch (e) {
            logger.error(e)

            throw e
          } finally {
            if (context.browser !== null) {
              logger.debug(
                `Closing headless chrome [ ${context.version} ] for [ ${source} ]`
              )

              await context.browser.close()

              logger.info(
                `Closed headless chrome [ ${context.version} ] for [ ${source} ]`
              )
            }
          }

          if (false) {
            fs.writeFile('./out.pdf', context.pdf)
          }

          return responder
            .setHeader('Content-Type', 'application/pdf')
            .setHeader(
              'Content-Disposition',
              filename ? `attachment; filename="${filename}"` : 'inline'
            )
            .send(context.pdf)
        }
      )
    },
  }
})()
