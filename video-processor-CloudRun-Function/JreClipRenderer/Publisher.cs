using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Google.Apis.Auth.OAuth2;
using Google.Apis.Upload;
using Google.Cloud.Storage.V1;
using StorageObject = Google.Apis.Storage.v1.Data.Object;

namespace JreClipRenderer;

public interface IPublisher
{
    Task<PublishedClip> PublishAsync(RenderedClip clip, IProgressSink progress, CancellationToken ct);
}

public sealed class GcsPublisher(StorageClient storage, UrlSigner signer, Settings settings) : IPublisher
{
    public async Task<PublishedClip> PublishAsync(RenderedClip clip, IProgressSink progress, CancellationToken ct)
    {
        var objectName = $"{settings.OutputPrefix}/{settings.JobId}/final_video.mp4";
        var shortId = settings.JobId.Length > 8 ? settings.JobId[..8] : settings.JobId;
        var metadata = new StorageObject
        {
            Bucket = settings.OutputBucket,
            Name = objectName,
            ContentType = "video/mp4",
            ContentDisposition = $"attachment; filename=\"jre-clip-{shortId}.mp4\"",
            CacheControl = "private, max-age=3600",
        };

        progress.Report(JobStatus.Uploading, 90, "Uploading your video...");
        var size = Math.Max(1, clip.SizeBytes);
        var uploadProgress = new Progress<IUploadProgress>(p =>
        {
            if (p.Status == UploadStatus.Uploading)
                progress.Report(JobStatus.Uploading, 90 + (int)(9 * p.BytesSent / size), "Uploading your video...");
        });

        await using (var file = new FileStream(clip.Path, FileMode.Open, FileAccess.Read, FileShare.Read,
                         bufferSize: 1 << 20, FileOptions.Asynchronous | FileOptions.SequentialScan))
        {
            // 8 MiB chunks: resumable on transient errors without buffering the whole file in memory.
            await storage.UploadObjectAsync(metadata, file,
                new UploadObjectOptions { ChunkSize = 8 * 1024 * 1024 }, ct, uploadProgress).ConfigureAwait(false);
        }

        // V4 signed URLs max out at 7 days; stay a minute under to avoid clock-skew rejections.
        var lifetime = settings.SignedUrlLifetime > TimeSpan.FromDays(7) - TimeSpan.FromMinutes(1)
            ? TimeSpan.FromDays(7) - TimeSpan.FromMinutes(1)
            : settings.SignedUrlLifetime;
        var url = await signer.SignAsync(settings.OutputBucket, objectName, lifetime, HttpMethod.Get,
            SigningVersion.V4, ct).ConfigureAwait(false);

        return new PublishedClip(url, $"gs://{settings.OutputBucket}/{objectName}", DateTimeOffset.UtcNow + lifetime);
    }
}

public sealed class LocalPublisher(Settings settings) : IPublisher
{
    public Task<PublishedClip> PublishAsync(RenderedClip clip, IProgressSink progress, CancellationToken ct)
    {
        var dir = settings.OutputDir ?? Path.Combine(Path.GetTempPath(), "jre-clips");
        Directory.CreateDirectory(dir);
        var target = Path.Combine(dir, $"{settings.JobId}.mp4");
        File.Copy(clip.Path, target, overwrite: true);
        return Task.FromResult(new PublishedClip(target, target, null));
    }
}

/// <summary>
/// Signs via the IAM Credentials signBlob API, so no private key is ever present: works with the
/// Cloud Run metadata-server identity and with a plain user access token when testing locally.
/// The signing identity needs roles/iam.serviceAccountTokenCreator on itself.
/// </summary>
public sealed class IamBlobSigner(HttpClient http, ITokenAccess tokens, string serviceAccountEmail) : UrlSigner.IBlobSigner
{
    public string Id => serviceAccountEmail;
    public string Algorithm => "GOOG4-RSA-SHA256";

    public string CreateSignature(byte[] data, UrlSigner.BlobSignerParameters signerParameters) =>
        CreateSignatureAsync(data, signerParameters, CancellationToken.None).GetAwaiter().GetResult();

    public async Task<string> CreateSignatureAsync(
        byte[] data, UrlSigner.BlobSignerParameters signerParameters, CancellationToken cancellationToken)
    {
        var token = await tokens.GetAccessTokenForRequestAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
        using var request = new HttpRequestMessage(HttpMethod.Post,
            $"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{Uri.EscapeDataString(serviceAccountEmail)}:signBlob")
        {
            Content = JsonContent.Create(new { payload = Convert.ToBase64String(data) }),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

        using var response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            throw new InvalidOperationException($"signBlob failed ({(int)response.StatusCode}): {body}");
        }
        using var json = await JsonDocument.ParseAsync(
            await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false),
            cancellationToken: cancellationToken).ConfigureAwait(false);
        return json.RootElement.GetProperty("signedBlob").GetString()!;
    }

    /// <summary>Email of the identity Cloud Run runs us as, from the metadata server.</summary>
    public static async Task<string> GetDefaultServiceAccountEmailAsync(HttpClient http, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get,
            "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email");
        request.Headers.Add("Metadata-Flavor", "Google");
        using var response = await http.SendAsync(request, ct).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false)).Trim();
    }
}
