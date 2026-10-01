<!-- Added to the implement, review and repair prompts under "Project rules".
     Say what an agent in this repo must read first, must never do, and how a
     visual or data change is proven - the things the generic prompt cannot know.
     Answer three questions here (the /sandcastle skill's init action asks them):
     - Generated files: which committed files does a command write, and which command?
       Agents edit the source and run it. Declare them under `generated` in config.ts too.
     - Do not touch: which paths must an agent never change?
     - Drift: which gate proves the generated files match their sources (README: A gate
       for generated files)? If none, say why. -->
