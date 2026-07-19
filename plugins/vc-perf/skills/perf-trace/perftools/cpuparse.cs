#:package Microsoft.Diagnostics.Tracing.TraceEvent@3.1.16
#:property ManagePackageVersionsCentrally=false
#:property Nullable=enable

using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Diagnostics.Tracing.Etlx;

// Usage: cpuparse <trace.nettrace> [topN]
//
// Attributes on-CPU thread-time from a `dotnet-trace collect --profile dotnet-sampled-thread-time`
// capture (SampleProfiler events, ~100Hz per managed thread). Two views: raw (all samples,
// dominated by idle threadpool waits on a lightly loaded host) and ACTIVE (idle/background/wait
// stacks excluded, surfacing actual request-path work).
if (args.Length < 1)
{
    Console.Error.WriteLine("usage: cpuparse <trace.nettrace> [topN]");
    Environment.Exit(1);
}
var path = args[0];
var topN = args.Length > 1 ? int.Parse(args[1]) : 25;
bool IsBcl(string m) => m is "System.Private.CoreLib" or "System.Collections"
    or "System.Collections.Immutable" or "System.Linq" or "System.Linq.Expressions"
    or "System.Memory" or "System.ObjectModel" or "System.Private.Xml" or "netstandard"
    or "System.Text.RegularExpressions" or "System.Runtime" or "System.Collections.Concurrent"
    or "System.Threading" or "System.Threading.Tasks" or "System.Text.Json" or "System.Net.Sockets";

var etlx = TraceLog.CreateFromEventPipeDataFile(path);
using var log = new TraceLog(etlx);
long total = 0;
var byLeaf = new Dictionary<string, long>();
var byOwner = new Dictionary<string, long>();
foreach (var d in log.Events)
{
    if (d.ProviderName is null || !d.ProviderName.Contains("SampleProfiler"))
    {
        continue;
    }

    var cs = d.CallStack();
    if (cs == null)
    {
        continue;
    }

    total++;
    var leaf = $"{cs.CodeAddress.ModuleName}!{cs.CodeAddress.FullMethodName}";
    byLeaf[leaf] = byLeaf.GetValueOrDefault(leaf) + 1;
    var owner = "(bcl-only)";
    for (var f = cs; f != null; f = f.Caller)
    {
        if (!IsBcl(f.CodeAddress.ModuleName))
        {
            owner = $"{f.CodeAddress.ModuleName}!{f.CodeAddress.FullMethodName}";
            break;
        }
    }
    byOwner[owner] = byOwner.GetValueOrDefault(owner) + 1;
}
if (total == 0)
{
    Console.Error.WriteLine("cpuparse: no CPU sample events in this trace — wrong profile (need dotnet-sampled-thread-time / cpu-sampling) or an empty capture.");
    Environment.Exit(1);
}

Console.WriteLine($"# CPU samples (on-CPU only): {total}");
Console.WriteLine($"\n## Top {topN} SELF (leaf) methods by CPU sample %");
foreach (var kv in byLeaf.OrderByDescending(x => x.Value).Take(topN))
{
    Console.WriteLine($"{100.0 * kv.Value / total,6:F1}%  {kv.Key}");
}
Console.WriteLine($"\n## Top {topN} RESPONSIBLE callers (first non-BCL) by CPU sample %");
foreach (var kv in byOwner.OrderByDescending(x => x.Value).Take(topN))
{
    Console.WriteLine($"{100.0 * kv.Value / total,6:F1}%  {kv.Key}");
}

// ---- ACTIVE view: exclude idle/background/wait samples, surface request-path work ----
string[] idleModules =
[
    "Hangfire.Core", "Hangfire.PostgreSql", "OpenTelemetry",
    "OpenTelemetry.Instrumentation.StackExchangeRedis", "Microsoft.ApplicationInsights",
    "Microsoft.AI.PerfCounterCollector", "StackExchange.Redis", "System.IO.FileSystem.Watcher",
];
string[] waitLeaves =
[
    "WaitHandle.", "LowLevelLifoSemaphore", "Thread.Sleep", "Monitor.Wait",
    "ManualResetEventSlim.Wait", "Task.InternalWaitCore", "PollGC", "Heartbeat.TimerLoop",
    "HostingAbstractionsHostExtensions.Run", "WaitForDispatchers",
];
var active = new Dictionary<string, long>();
long activeTotal = 0;
foreach (var d in log.Events)
{
    if (d.ProviderName is null || !d.ProviderName.Contains("SampleProfiler"))
    {
        continue;
    }

    var cs = d.CallStack();
    if (cs == null)
    {
        continue;
    }

    var idle = false;
    var owner = "(bcl-only)";
    var ownerSet = false;
    for (var f = cs; f != null; f = f.Caller)
    {
        var m = f.CodeAddress.ModuleName;
        var full = f.CodeAddress.FullMethodName;
        if (idleModules.Contains(m))
        {
            idle = true;
            break;
        }
        if (waitLeaves.Any(w => full.Contains(w)))
        {
            idle = true;
            break;
        }
        if (!ownerSet && !IsBcl(m))
        {
            owner = $"{m}!{full}";
            ownerSet = true;
        }
    }
    if (idle)
    {
        continue;
    }

    activeTotal++;
    active[owner] = active.GetValueOrDefault(owner) + 1;
}
Console.WriteLine($"\n## ACTIVE (idle/background/wait excluded): {activeTotal} samples = {100.0 * activeTotal / total:F1}% of all");
foreach (var kv in active.OrderByDescending(x => x.Value).Take(topN))
{
    Console.WriteLine($"{100.0 * kv.Value / activeTotal,6:F1}% (act) / {100.0 * kv.Value / total,4:F2}% (all)  {kv.Key}");
}
