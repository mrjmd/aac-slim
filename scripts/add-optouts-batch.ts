import { Redis } from '@upstash/redis'
import * as dotenv from 'dotenv'

dotenv.config()

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

async function addOptOuts() {
  // New opt-outs to add
  const newOptOuts = [
    '6175011611',  // (617) 501-1611
    '9373719807',  // (937) 371-9807
    '7814131197',  // (781) 413-1197
    '7819756312',  // (781) 975-6312 - "Thanks for the spam"
    '5103725532',  // (510) 372-5532
    '6179019642',  // (617) 901-9642
  ]

  // Previously added (verify they're still there)
  const previouslyAdded = [
    '7819274477',  // (781) 927-4477
    '6175489394',  // (617) 548-9394
    '3392350436',  // (339) 235-0436
  ]

  console.log('Adding new opt-outs...')
  for (const phone of newOptOuts) {
    await redis.sadd('optouts:phones', phone)
    console.log(`Added ${phone} to opt-out list`)
  }

  console.log('\nVerifying all opt-outs...')
  const allPhones = [...newOptOuts, ...previouslyAdded]
  for (const phone of allPhones) {
    const isMember = await redis.sismember('optouts:phones', phone)
    console.log(`${phone}: ${isMember === 1 ? '✓ in list' : '✗ NOT FOUND'}`)
  }

  // Get total count
  const totalCount = await redis.scard('optouts:phones')
  console.log(`\nTotal phones in opt-out list: ${totalCount}`)
}

addOptOuts().catch(console.error)
