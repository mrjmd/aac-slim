import * as dotenv from 'dotenv'
import { submitPhoneBatch, getValidationResults, PhoneValidationResult } from '../src/clients/searchbug'

dotenv.config()

// The 12 undelivered phone numbers from the campaign
const undeliveredNumbers = [
  { id: '1', phone: '6177711365' },   // (617) 771-1365
  { id: '2', phone: '7814734151' },   // (781) 473-4151
  { id: '3', phone: '6265605313' },   // (626) 560-5313
  { id: '4', phone: '7812494871' },   // (781) 249-4871
  { id: '5', phone: '5082648224' },   // (508) 264-8224
  { id: '6', phone: '5089823006' },   // (508) 982-3006
  { id: '7', phone: '2053880469' },   // (205) 388-0469
  { id: '8', phone: '7819831658' },   // (781) 983-1658
  { id: '9', phone: '7815881845' },   // (781) 588-1845
  { id: '10', phone: '6179829634' },  // (617) 982-9634
  { id: '11', phone: '6178187344' },  // (617) 818-7344
  { id: '12', phone: '6177671044' },  // (617) 767-1044
]

async function queryUndelivered() {
  console.log('Querying SearchBug for 12 undelivered phone numbers...\n')

  try {
    // Submit batch
    console.log('Submitting batch to SearchBug...')
    const { key, estimatedMinutes } = await submitPhoneBatch(undeliveredNumbers)
    console.log(`Batch submitted. Key: ${key}`)
    console.log(`Estimated time: ${estimatedMinutes} minute(s)\n`)

    // Poll for results with custom logic to see raw response
    console.log('Waiting for results...')
    let results: PhoneValidationResult[] = []
    const maxWaitMs = 60000 // 1 minute
    const startTime = Date.now()
    const pollInterval = 3000

    while (Date.now() - startTime < maxWaitMs) {
      const response = await getValidationResults(key)
      console.log(`  Raw response:`, JSON.stringify(response, null, 2))

      if (response.STATUS === 'Complete') {
        results = response.DATA || []
        break
      }

      if (response.STATUS === 'Failed' || response.STATUS === 'Stopped') {
        console.error(`SearchBug validation ${response.STATUS}:`, response.ERROR)
        process.exit(1)
      }

      if (response.PERCENT) {
        console.log(`  Progress: ${response.PERCENT}% - ${response.MINLEFT} minutes remaining`)
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }

    console.log('\n=== SEARCHBUG RESULTS ===\n')

    // Categorize results
    const voip: PhoneValidationResult[] = []
    const cellular: PhoneValidationResult[] = []
    const landline: PhoneValidationResult[] = []
    const inactive: PhoneValidationResult[] = []
    const dnc: PhoneValidationResult[] = []
    const notVerified: PhoneValidationResult[] = []

    for (const result of results) {
      console.log(`Phone: ${result.NUMBER}`)
      console.log(`  TYPE: ${result.TYPE}`)
      console.log(`  STATUS: ${result.STATUS}`)
      console.log(`  DNC: ${result.DNC}`)
      console.log(`  TCPA: ${result.TCPA}`)
      console.log(`  CARRIER: ${result.CARRIER}`)
      console.log(`  PORTED: ${result.PORTED}`)
      console.log(`  STATE: ${result.STATE}`)
      console.log('')

      // Categorize
      if (result.TYPE === 'VOIP') voip.push(result)
      else if (result.TYPE === 'CELLULAR') cellular.push(result)
      else if (result.TYPE === 'LANDLINE') landline.push(result)

      if (result.STATUS === 'INACTIVE') inactive.push(result)
      if (result.STATUS === 'NOT_VERIFIED') notVerified.push(result)
      if (result.DNC !== 'NO') dnc.push(result)
    }

    console.log('=== SUMMARY ===\n')
    console.log(`Total: ${results.length}`)
    console.log(`VOIP: ${voip.length}`)
    console.log(`CELLULAR: ${cellular.length}`)
    console.log(`LANDLINE: ${landline.length}`)
    console.log(`INACTIVE: ${inactive.length}`)
    console.log(`NOT_VERIFIED: ${notVerified.length}`)
    console.log(`DNC: ${dnc.length}`)

    if (voip.length > 0) {
      console.log('\n=== VOIP NUMBERS ===')
      for (const v of voip) {
        console.log(`  ${v.NUMBER} - ${v.CARRIER} - ${v.STATUS}`)
      }
    }

    if (inactive.length > 0) {
      console.log('\n=== INACTIVE NUMBERS ===')
      for (const i of inactive) {
        console.log(`  ${i.NUMBER} - ${i.CARRIER} - ${i.TYPE}`)
      }
    }

    if (notVerified.length > 0) {
      console.log('\n=== NOT VERIFIED NUMBERS ===')
      for (const n of notVerified) {
        console.log(`  ${n.NUMBER} - ${n.CARRIER} - ${n.TYPE}`)
      }
    }

    console.log('\n=== ANALYSIS ===')
    if (voip.length > 0) {
      console.log(`\nVOIP Issue: ${voip.length}/${results.length} undelivered numbers are VOIP.`)
      console.log('Recommendation: Consider adding VOIP filtering to prevent bounces.')
    }
    if (inactive.length > 0) {
      console.log(`\nInactive Issue: ${inactive.length} numbers are INACTIVE.`)
      console.log('These should have been filtered by SearchBug. Check filterResults() logic.')
    }
    if (notVerified.length > 0) {
      console.log(`\nNot Verified: ${notVerified.length} numbers could not be verified.`)
      console.log('These pass through currently - may want to flag or filter.')
    }
    if (cellular.length > 0 && inactive.length === 0) {
      console.log(`\nCellular that bounced: ${cellular.length} numbers are CELLULAR + ACTIVE.`)
      console.log('These are carrier issues, not SearchBug filtering problems.')
    }

  } catch (error) {
    console.error('Error querying SearchBug:', error)
    process.exit(1)
  }
}

queryUndelivered()
