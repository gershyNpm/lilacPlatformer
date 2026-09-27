# Lilac Platformer

## Vocabulary

- **Script**: executable code logic. Instructions for how to do something, without actually doing it. Literal typescript.
- **Platform**: an entity offering computational units and capable of running a script. Platforms can operate long-term (like long-lived EC2 instances), medium-term (like fargate instances), or short-term (like lambda executions). A Platform provides certain features; for a script to function fully, the Platform which executes it must fulfill its requirements. Some example Platform features are:
  - Nodejs (lilac requires 24.0.0 and up)
  - Nodejs including @gershy/clearing (required by lilac)
  - Filesystem access
  - Public internet access
  - Iam permissions / aws credentials / other 3rd party credentials
  - Tls certificates
  - Presence of various installed shell utilities, e.g. terraform, docker
- **Platformer**: entity responsible for maintaining the existence of multiple Platforms

Note that Lilac has a strong opinion: the minimum a platform must offer is nodejs 24.0.0+ with @gershy/clearing installed.

## Overview

Think of a game where anyone can start a new lobby and players can join - this is the exact kind of use-case Platformer addresses.

This example illustrates setting up a Platformer, launching a Platform, initializing a Session on that Platform, and achieving a single request/response.

```ts
import { Platformer } from '@gershy/lilac-platformer';
import { Domain } from '@gershy/lilac-domain';

// Define garden
const garden = new Garden({
  
  ...props,
  seedBank: { Domain, Platformer },
  survey: ({ Domain, Platformer }, add) => {
    
    const platformer = add(new Platformer({
      name: 'coolGame',
      baseUrl: import.meta.url,
      power: 0,
      domain: new Domain({ addr: 'my-owned-domain.com' }),
      localData: null,
      launchFn: async v => null,
      invokeFn: async ({ launchData, user, inp }) => {
        return { msg: 'honk honk' };
      }
    }));
    
    return { platformer: platformer.addPollen() };
    
  }
  
});

// Grow garden, activate platform and communicate with it
await tracked(async trk => {
  
  const { ornaments: { platformer }, rake } = await garden.grow(/* ... */);
  trk(() => rake());
  
  const platformerDaemons = await platformer.runDaemons();
  trk(() => await platformerDaemons.cancel());
  
  const platform = await platformer.platformLaunch({ logger });
  trk(() => await platformer.platformCancel({ logger, platform }));
  
  const session = await platformer.platformSessionLaunch({ logger, platform });
  trk(() => await session.cancel({ logger }));
  
  const result = await session.send({ logger, reply: true, msg: 'hello??' });
  
  assertEqual(result, 'honk honk');
  
});
```

The above example immediately ends the Platformer after its short-term usage, but in general Platformer is intended for long-term usage, whereas individual Platforms are intended for mid-term to long-term usage (e.g. game lobbies that are ongoing for hours to months).

## Cloud-managed Platformers

Platformers are intentionally designed to themselves be managed on a cloud Platform. Consider shifting all Platform management from the local development environment to the cloud. This means that the action of spawning a new Platform is invoked by a cloud Platform (ec2, fargate, lambda). This model requires two things: application-level access to the Platformer, and cloud-based Platformer daemons.

### Application-level Platformer access

If Platformer management occurs in the cloud, it becomes essential to wire up a way to invoke Platformer functionality so clients can reach it. For example, if a user wants to create a new game lobby they would:
1. Invoke an api like `/api/v0/create-lobby -> post`
2. The api request is processed by e.g. an api gateway
3. The api gateway forwards the request to the cloud Platform hosting the Platformer, i.e. the Platformer's controller
4. The Platformer's controller has iam permissions to perform all Platformer management; it directly issues the aws requests to create the Platform hosting the game lobby

### Cloud-based Platformer daemons

Every healthy Platformer setup must be accompanied by Platformer-specific daemons which are persistent processes that keep the Platformer in a healthy state by repetitively running cleanup actions at various intervals - these actions include cleaning up orphaned resources and ensuring freshness of certain resources like tls certificates.

If the Platformer controller is a long-lived platform, it is simply responsible for calling `PollenPlatformer.prototype.runDaemons` once on startup. This uses simple nodejs event loop scheduling to maintain daemons.

Short-lived platforms can also be used as the Platformer controller. For example a lambda can serve as the controller, and can be accessed via e.g. http:

```ts
const garden = new Garden({
  
  ...props,
  seedBank: { Http, LambdaHttp, Platformer },
  survey: ({ Platformer }, add) => {
    
    const platformer = add(new Platformer({
      /* ... props ... */
      invokeFn: async () => ({ msg: 'honk honk' })
    }));
    
    const http = new Http({ name: 'http', cdn: null });
    
    // An http-accessible lambda controls platform creation
    await https.addHttpScript('/create-platform -> post', {}, new LambdaHttp({
      
      localData: lbd => ({ platformer: platformer.addPollen(lbd) }),
      launchData: ({ localData }) => ({ ...localData }),
      invokeFn: ({ logger, launchData, args }) => {
        const { platformer } = launchData;
        const platform = await platformer.platformLaunch({ logger });
        return { code: 200, { platform: platform[cl.slice]([ 'id' ]) } };
      }
      
    }));
    
    return { platformer: platformer.addPollen() };
    
  }
  
});
```

But the above example fails to spawn daemons, and as such the Platformer controller will be prone to undesired behaviour: accumulation of orphaned resources, stale tls certs, etc. With short-term Platforms like lambda, long-term/persistent processes like Platformer daemons need to be managed some other way. A possibility is via a cron-like cloud process like aws eventbridge, which repetitively executes the Platformer daemon sweeps.